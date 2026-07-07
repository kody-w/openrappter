/**
 * OuroborosAgent Parity Tests
 * Tests for the self-evolving agent — evolution catalog, source transforms,
 * full generation cycle, safety, and data sloshing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  OuroborosAgent, EVOLUTION_CATALOG, EVOLVED_DIR,
  assessEvolution, checkWordStats, checkCaesarCipher, checkPatterns,
  checkSentiment, checkReflection, countNegatedSentimentWords, computeCapabilityTrajectories, scoreInputDifficulty, loadLineageLog, saveLineageLog, computeTrends,
} from '../../agents/OuroborosAgent.js';
import type { EvolutionReport, LineageRunSummary } from '../../agents/OuroborosAgent.js';
import type { LLMProvider, ProviderResponse } from '../../providers/types.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

// Shared temp directory for tests
const testWorkDir = join(tmpdir(), `ouroboros-test-${Date.now()}`);

// Helper: read the OuroborosAgent source for transform tests
function getAgentSource(): string {
  const agentPath = join(__dirname, '../../agents/OuroborosAgent.ts');
  return readFileSync(agentPath, 'utf-8');
}

describe('OuroborosAgent Parity', () => {
  afterAll(() => {
    // Clean up all temp directories created by tests
    if (existsSync(testWorkDir)) {
      rmSync(testWorkDir, { recursive: true, force: true });
    }
  });

  describe('metadata', () => {
    it('should have name Ouroboros', () => {
      const agent = new OuroborosAgent(testWorkDir);
      expect(agent.name).toBe('Ouroboros');
    });

    it('should have descriptive metadata', () => {
      const agent = new OuroborosAgent(testWorkDir);
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Ouroboros');
      expect(agent.metadata.description.toLowerCase()).toContain('self-evolving');
      expect(agent.metadata.description).toContain('5 generations');
    });

    it('should have input parameter', () => {
      const agent = new OuroborosAgent(testWorkDir);
      const props = agent.metadata.parameters.properties;
      expect(props.input).toBeDefined();
      expect(props.input.type).toBe('string');
    });

    it('should extend BasicAgent', () => {
      const agent = new OuroborosAgent(testWorkDir);
      expect(agent).toBeInstanceOf(BasicAgent);
    });

    it('should start at generation 0', () => {
      const agent = new OuroborosAgent(testWorkDir);
      expect(agent.generation).toBe(0);
    });

    it('should accept custom workDir', () => {
      const customDir = join(tmpdir(), 'ouroboros-custom-test');
      const agent = new OuroborosAgent(customDir);
      expect(agent.workDir).toBe(customDir);
    });

    it('should default workDir to ~/.openrappter/evolved when not provided', () => {
      const agent = new OuroborosAgent();
      expect(agent.workDir).toBe(EVOLVED_DIR);
      expect(agent.workDir).toContain('.openrappter');
      expect(agent.workDir).toContain('evolved');
    });
  });

  describe('evolution catalog', () => {
    it('should have exactly 5 entries', () => {
      expect(EVOLUTION_CATALOG).toHaveLength(5);
    });

    it('should have name and description for each entry', () => {
      for (const entry of EVOLUTION_CATALOG) {
        expect(entry.name).toBeDefined();
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.description).toBeDefined();
        expect(typeof entry.description).toBe('string');
      }
    });

    it('should have an apply function for each entry', () => {
      for (const entry of EVOLUTION_CATALOG) {
        expect(typeof entry.apply).toBe('function');
      }
    });

    it('should have the correct capability names in order', () => {
      const names = EVOLUTION_CATALOG.map(e => e.name);
      expect(names).toEqual([
        'Word Statistics',
        'Caesar Cipher',
        'Pattern Detection',
        'Sentiment Heuristic',
        'Self-Reflection',
      ]);
    });
  });

  describe('source transforms', () => {
    it('should update generation number', () => {
      const source = getAgentSource();
      const gen1 = EVOLUTION_CATALOG[0].apply(source, 1);
      expect(gen1).toContain('readonly generation = 1');
      expect(gen1).not.toMatch(/readonly generation = 0/);
    });

    it('should update generation number in compiled JS (no readonly keyword)', () => {
      // Simulate compiled JS where TypeScript strips `readonly`
      const compiledSource = getAgentSource().replace(/readonly generation = 0/, 'generation = 0');
      const gen1 = EVOLUTION_CATALOG[0].apply(compiledSource, 1);
      // The class field should be bumped to 1
      expect(gen1).toMatch(/^\s*generation = 1/m);
      // Should not contain the original value
      expect(gen1).not.toMatch(/^\s*generation = 0/m);
    });

    it('should rename class from OuroborosAgent to OuroborosGen1Agent', () => {
      const source = getAgentSource();
      const gen1 = EVOLUTION_CATALOG[0].apply(source, 1);
      expect(gen1).toContain('class OuroborosGen1Agent');
      expect(gen1).not.toContain('class OuroborosAgent');
    });

    it('should insert wordStats method for Gen 1', () => {
      const source = getAgentSource();
      const gen1 = EVOLUTION_CATALOG[0].apply(source, 1);
      expect(gen1).toContain('wordStats(text)');
      expect(gen1).toContain('word_count');
      expect(gen1).toContain('unique_words');
      expect(gen1).toContain('most_frequent');
    });

    it('should insert capability call after EVOLVED CAPABILITIES marker', () => {
      const source = getAgentSource();
      const gen1 = EVOLUTION_CATALOG[0].apply(source, 1);
      const markerIdx = gen1.indexOf('// --- EVOLVED CAPABILITIES ---');
      expect(markerIdx).toBeGreaterThan(-1);
      // Check that the capability call exists in the source after the marker
      const afterMarker = gen1.slice(markerIdx);
      expect(afterMarker).toContain('capabilityResults.wordStats = this.wordStats(inputText)');
    });

    it('should chain transforms correctly through all 5 generations', () => {
      let source = getAgentSource();
      for (let i = 0; i < 5; i++) {
        source = EVOLUTION_CATALOG[i].apply(source, i + 1);
      }
      // Gen 5 should have all capabilities
      expect(source).toContain('readonly generation = 5');
      expect(source).toContain('class OuroborosGen5Agent');
      expect(source).toContain('wordStats(text)');
      expect(source).toContain('caesarEncrypt(text,');
      expect(source).toContain('caesarDecrypt(text,');
      expect(source).toContain('detectPatterns(text)');
      expect(source).toContain('analyzeSentiment(text)');
      expect(source).toContain('reflectOnEvolution()');
    });

    it('should preserve the EVOLVED CAPABILITIES marker through transforms', () => {
      let source = getAgentSource();
      for (let i = 0; i < 5; i++) {
        source = EVOLUTION_CATALOG[i].apply(source, i + 1);
        expect(source).toContain('// --- EVOLVED CAPABILITIES ---');
      }
    });

    it('should accumulate capability calls through transforms', () => {
      let source = getAgentSource();
      for (let i = 0; i < 5; i++) {
        source = EVOLUTION_CATALOG[i].apply(source, i + 1);
      }
      // Gen 5 should call all capabilities
      expect(source).toContain('capabilityResults.wordStats');
      expect(source).toContain('capabilityResults.caesarCipher');
      expect(source).toContain('capabilityResults.patterns');
      expect(source).toContain('capabilityResults.sentiment');
      expect(source).toContain('capabilityResults.reflection');
    });
  });

  describe('safety', () => {
    it('should not add dangerous imports in evolved source', () => {
      let source = getAgentSource();
      for (let i = 0; i < 5; i++) {
        source = EVOLUTION_CATALOG[i].apply(source, i + 1);
      }
      // The evolved methods themselves should not import net/http/child_process
      // (child_process is in the original source for diff, but evolved methods don't add new ones)
      const methodBodies = [
        'wordStats', 'caesarEncrypt', 'caesarDecrypt',
        'detectPatterns', 'analyzeSentiment', 'reflectOnEvolution',
      ];
      for (const methodName of methodBodies) {
        const methodStart = source.indexOf(`${methodName}(`);
        // Find the method body (from the method declaration to the next method or class end)
        const methodSection = source.slice(methodStart, methodStart + 500);
        expect(methodSection).not.toContain("require('net')");
        expect(methodSection).not.toContain("require('http')");
        expect(methodSection).not.toContain('import(');
      }
    });

    it('should not introduce eval() in evolved source', () => {
      let source = getAgentSource();
      for (let i = 0; i < 5; i++) {
        source = EVOLUTION_CATALOG[i].apply(source, i + 1);
      }
      // Check that the added methods don't use eval
      const gen5Methods = source.slice(source.indexOf('wordStats('));
      expect(gen5Methods).not.toContain('eval(');
    });
  });

  describe('full cycle integration', () => {
    let result: Record<string, unknown>;
    let workDir: string;

    beforeAll(async () => {
      workDir = join(testWorkDir, `integration-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const input = 'The amazing fox is great. Email: test@example.com, URL: https://test.dev, Date: 2026-01-15';
      const resultStr = await agent.execute({ input });
      result = JSON.parse(resultStr);
    }, 30000);

    it('should return success status', () => {
      expect(result.status).toBe('success');
    });

    it('should report 5 generations', () => {
      expect(result.generations).toBe(5);
    });

    it('should have evolution log with entries for all generations', () => {
      const log = result.evolution_log as string[];
      expect(log).toBeDefined();
      expect(log.length).toBeGreaterThanOrEqual(10); // At least 2 entries per gen
      // Check that all generations are mentioned
      for (let g = 0; g <= 5; g++) {
        expect(log.some(line => line.includes(`Gen ${g}`))).toBe(true);
      }
    });

    it('should have created all 5 generation files', () => {
      for (let g = 1; g <= 5; g++) {
        // In test (vitest) mode, files are .ts; in compiled mode, .mjs
        const tsPath = join(workDir, `OuroborosGen${g}Agent.ts`);
        const mjsPath = join(workDir, `OuroborosGen${g}Agent.mjs`);
        expect(existsSync(tsPath) || existsSync(mjsPath)).toBe(true);
      }
    });

    it('should have capabilities output from Gen 5', () => {
      const caps = result.capabilities_output as Record<string, unknown>;
      expect(caps).toBeDefined();
      expect(caps.wordStats).toBeDefined();
      expect(caps.caesarCipher).toBeDefined();
      expect(caps.patterns).toBeDefined();
      expect(caps.sentiment).toBeDefined();
      expect(caps.reflection).toBeDefined();
    });

    it('should have correct word stats', () => {
      const caps = result.capabilities_output as Record<string, unknown>;
      const ws = caps.wordStats as Record<string, unknown>;
      expect(ws.word_count).toBeGreaterThan(0);
      expect(ws.unique_words).toBeGreaterThan(0);
      expect(ws.avg_word_length).toBeGreaterThan(0);
      expect(ws.most_frequent).toBeDefined();
      expect(ws.entropy as number).toBeGreaterThan(2.0);
      // Mostly-unique natural text — Simpson's index should be near 1
      expect(ws.simpson_diversity as number).toBeGreaterThan(0.9);
      expect(ws.simpson_diversity as number).toBeLessThanOrEqual(1);
    });

    it('should have caesar cipher with roundtrip', () => {
      const caps = result.capabilities_output as Record<string, unknown>;
      const cc = caps.caesarCipher as Record<string, string>;
      expect(cc.encrypted).toBeDefined();
      expect(cc.decrypted).toBeDefined();
      // ROT13 roundtrip: decrypt(encrypt(text)) === text
      expect(cc.decrypted).toContain('amazing');
    });

    it('should detect patterns in input', () => {
      const caps = result.capabilities_output as Record<string, unknown>;
      const p = caps.patterns as Record<string, string[]>;
      expect(p.emails).toContain('test@example.com');
      expect(p.urls).toEqual(expect.arrayContaining([expect.stringContaining('https://test.dev')]));
      expect(p.dates).toContain('2026-01-15');
    });

    it('should analyze sentiment', () => {
      const caps = result.capabilities_output as Record<string, unknown>;
      const s = caps.sentiment as Record<string, unknown>;
      expect(s.score).toBeDefined();
      expect(typeof s.score).toBe('number');
      expect(s.label).toBeDefined();
      expect(['positive', 'negative', 'neutral']).toContain(s.label);
      // Input has "amazing" and "great" — should be positive
      expect((s.positive as string[]).length).toBeGreaterThan(0);
    });

    it('should have self-reflection from Gen 5', () => {
      const caps = result.capabilities_output as Record<string, unknown>;
      const r = caps.reflection as Record<string, unknown>;
      expect(r.generation).toBe(5);
      expect(r.className).toContain('Gen5');
      expect(r.capability_count).toBeGreaterThan(5);
      expect(r.identity).toContain('generation 5');
    });

    it('should have diff summary', () => {
      const ds = result.diff_summary as Record<string, unknown>;
      expect(ds).toBeDefined();
      expect(ds.gen0_lines).toBeGreaterThan(0);
      expect(ds.gen5_lines).toBeGreaterThan(ds.gen0_lines as number);
      expect((ds.lines_added as number)).toBeGreaterThan(0);
      expect(ds.methods_gained).toEqual([
        'wordStats',
        'caesarEncrypt',
        'caesarDecrypt',
        'detectPatterns',
        'analyzeSentiment',
        'reflectOnEvolution',
      ]);
    });

    it('should have diff output', () => {
      expect(result.diff).toBeDefined();
      expect(typeof result.diff).toBe('string');
      expect((result.diff as string).length).toBeGreaterThan(0);
    });
  });

  describe('data sloshing', () => {
    it('should include data_slush in final output', async () => {
      const workDir = join(testWorkDir, `slush-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const resultStr = await agent.execute({ input: 'test input' });
      const result = JSON.parse(resultStr);

      expect(result.data_slush).toBeDefined();
      expect(result.data_slush.source_agent).toBe('Ouroboros');
      expect(result.data_slush.timestamp).toBeDefined();
      expect(result.data_slush.signals).toBeDefined();
      expect(result.data_slush.signals.generations_evolved).toBe(5);
      expect(result.data_slush.signals.capabilities_added).toBe(5);
    }, 30000);

    it('should set lastDataSlush after execute', async () => {
      const workDir = join(testWorkDir, `lastslush-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      await agent.execute({ input: 'test' });
      expect(agent.lastDataSlush).toBeDefined();
    }, 30000);

    it('should include report_summary in data_slush signals', async () => {
      const workDir = join(testWorkDir, `slush-report-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const resultStr = await agent.execute({ input: 'The amazing fox is great' });
      const result = JSON.parse(resultStr);
      const signals = result.data_slush.signals;

      expect(signals.report_summary).toBeDefined();
      expect(signals.report_summary.overall_quality).toBeGreaterThanOrEqual(0);
      expect(signals.report_summary.status).toBeDefined();
      expect(signals.report_summary.capability_scores).toHaveLength(5);
      expect(signals.report_summary.summaries).toHaveLength(5);
    }, 30000);

    it('should include capability_digests in data_slush signals', async () => {
      const workDir = join(testWorkDir, `slush-digests-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const input = 'The amazing fox. Email: a@b.com Date: 2026-01-01';
      const resultStr = await agent.execute({ input });
      const result = JSON.parse(resultStr);
      const digests = result.data_slush.signals.capability_digests;

      expect(digests).toBeDefined();
      expect(digests.word_stats).toBeDefined();
      expect(digests.word_stats.word_count).toBeGreaterThan(0);
      expect(typeof digests.word_stats.unique_ratio).toBe('number');
      expect(digests.caesar_cipher).toBeDefined();
      expect(typeof digests.caesar_cipher.roundtrip_intact).toBe('boolean');
      expect(digests.patterns).toBeDefined();
      expect(digests.patterns.total_patterns).toBeGreaterThan(0);
      expect(digests.sentiment).toBeDefined();
      expect(digests.sentiment.label).toBeDefined();
      expect(digests.reflection).toBeDefined();
      expect(digests.reflection.generation).toBe(5);
    }, 30000);

    it('should include input_profile in data_slush signals', async () => {
      const workDir = join(testWorkDir, `slush-profile-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const input = 'Hello world https://example.com test@x.com 2026-01-01';
      const resultStr = await agent.execute({ input });
      const result = JSON.parse(resultStr);
      const profile = result.data_slush.signals.input_profile;

      expect(profile).toBeDefined();
      expect(profile.length).toBe(input.length);
      expect(profile.word_count).toBeGreaterThan(0);
      expect(profile.has_email).toBe(true);
      expect(profile.has_url).toBe(true);
      expect(profile.has_date).toBe(true);
    }, 30000);

    it('should include run_number in data_slush signals', async () => {
      const workDir = join(testWorkDir, `slush-runnum-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const resultStr = await agent.execute({ input: 'test' });
      const result = JSON.parse(resultStr);
      expect(result.data_slush.signals.run_number).toBe(1);
    }, 30000);

    it('should auto-load lineage from log across runs (no manual upstream_slush)', async () => {
      const workDir = join(testWorkDir, `slush-chain-${Date.now()}`);

      // Run 1: first evolution — writes lineage log
      const agent1 = new OuroborosAgent(workDir);
      const result1Str = await agent1.execute({ input: 'The amazing fox is great' });
      const result1 = JSON.parse(result1Str);
      const slush1 = result1.data_slush;
      expect(slush1.signals.run_number).toBe(1);
      expect(slush1.signals.lineage).toBeNull();

      // Verify lineage log was written
      const log1 = loadLineageLog(workDir);
      expect(log1).toHaveLength(1);
      expect(log1[0].run_number).toBe(1);

      // Run 2: auto-loads lineage from log — no upstream_slush needed
      const agent2 = new OuroborosAgent(workDir);
      const result2Str = await agent2.execute({
        input: 'The brilliant fox is amazing and wonderful',
      });
      const result2 = JSON.parse(result2Str);
      const slush2 = result2.data_slush;

      expect(slush2.signals.run_number).toBe(2);
      expect(slush2.signals.lineage).not.toBeNull();
      expect(slush2.signals.lineage.run_number).toBe(2);
      expect(slush2.signals.lineage.prior_quality).toBe(slush1.signals.report_summary.overall_quality);
      expect(slush2.signals.lineage.prior_status).toBe(slush1.signals.report_summary.status);
      expect(slush2.signals.lineage.deltas).toHaveLength(5);
      expect(slush2.signals.lineage.cumulative_runs).toBe(2);
      expect(slush2.signals.lineage.history).toHaveLength(1);
      expect(typeof slush2.signals.lineage.trajectory).toBe('number');

      // Verify lineage log now has 2 entries
      const log2 = loadLineageLog(workDir);
      expect(log2).toHaveLength(2);
      expect(log2[1].run_number).toBe(2);
    }, 60000);

    it('should persist lineage log and load/save roundtrip', () => {
      const workDir = join(testWorkDir, `lineage-roundtrip-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });

      const runs: LineageRunSummary[] = [
        { run_number: 1, timestamp: '2026-01-01T00:00:00Z', input_hash: 'a', overall_quality: 50, status: 'developing', level_qualities: [50, 50, 50, 50, 50], level_statuses: ['developing', 'developing', 'developing', 'developing', 'developing'] },
        { run_number: 2, timestamp: '2026-01-02T00:00:00Z', input_hash: 'b', overall_quality: 55, status: 'developing', level_qualities: [55, 55, 55, 55, 55], level_statuses: ['developing', 'developing', 'developing', 'developing', 'developing'] },
      ];

      saveLineageLog(workDir, runs);
      const loaded = loadLineageLog(workDir);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].run_number).toBe(1);
      expect(loaded[1].overall_quality).toBe(55);
    });

    it('should return empty array for missing lineage log', () => {
      const workDir = join(testWorkDir, `lineage-missing-${Date.now()}`);
      const loaded = loadLineageLog(workDir);
      expect(loaded).toEqual([]);
    });
  });

  describe('capability scoring', () => {
    it('should pass all checks for complete word stats', () => {
      const ws = { word_count: 50, unique_words: 30, avg_word_length: 5.0, most_frequent: [1, 2, 3, 4, 5], entropy: 4.2, simpson_diversity: 0.95 };
      const result = checkWordStats(ws);
      expect(result.quality).toBe(100);
      expect(result.checks).toHaveLength(6);
      expect(result.checks.every(c => c.passed)).toBe(true);
    });

    it('should pass has_diversity at exactly the Simpson threshold (inclusive boundary)', () => {
      const ws = { word_count: 10, unique_words: 5, avg_word_length: 4.0, most_frequent: [1, 2, 3, 4, 5], entropy: 2.2, simpson_diversity: 0.7 };
      const result = checkWordStats(ws);
      // has_words ✓, has_diversity: 0.7 >= 0.7 ✓, balanced_length ✓, frequency_depth ✓, substantial_input ✓, lexical_entropy ✓
      expect(result.quality).toBe(100);
      const diversityCheck = result.checks.find(c => c.name === 'has_diversity');
      expect(diversityCheck?.passed).toBe(true);
    });

    it('should fail has_diversity below the Simpson threshold (repetition-dominated text)', () => {
      const ws = { word_count: 10, unique_words: 4, avg_word_length: 4.0, most_frequent: [1, 2, 3], entropy: 2.2, simpson_diversity: 0.42 };
      const result = checkWordStats(ws);
      // has_words ✓, has_diversity: 0.42 < 0.7 ✗, balanced_length ✓, frequency_depth ✓, substantial_input ✓, lexical_entropy ✓
      expect(result.quality).toBe(83);
      const diversityCheck = result.checks.find(c => c.name === 'has_diversity');
      expect(diversityCheck?.passed).toBe(false);
    });

    it('should fail has_diversity when simpson_diversity is missing (legacy output)', () => {
      const ws = { word_count: 10, unique_words: 9, avg_word_length: 4.0, most_frequent: [1, 2, 3], entropy: 2.2 };
      const result = checkWordStats(ws);
      expect(result.checks.find(c => c.name === 'has_diversity')?.passed).toBe(false);
    });

    it('should fail has_words for fewer than 3 words', () => {
      const ws = { word_count: 2, unique_words: 2, avg_word_length: 4.0, most_frequent: [1, 2, 3], entropy: 2.2, simpson_diversity: 0.9 };
      const result = checkWordStats(ws);
      // has_words: 2<3 ✗, has_diversity: ✓, balanced_length: ✓, frequency_depth: ✓, substantial_input: 2<10 ✗, lexical_entropy: ✓
      expect(result.quality).toBe(67);
      const wordsCheck = result.checks.find(c => c.name === 'has_words');
      expect(wordsCheck?.passed).toBe(false);
    });

    it('should fail substantial_input for fewer than 10 words', () => {
      const ws = { word_count: 7, unique_words: 6, avg_word_length: 4.0, most_frequent: [1, 2, 3], entropy: 2.2, simpson_diversity: 0.9 };
      const result = checkWordStats(ws);
      // has_words: ✓, has_diversity: ✓, balanced_length: ✓, frequency_depth: ✓, substantial_input: 7<10 ✗, lexical_entropy: ✓
      expect(result.quality).toBe(83);
      const substantialCheck = result.checks.find(c => c.name === 'substantial_input');
      expect(substantialCheck?.passed).toBe(false);
    });


    it('should pass lexical_entropy at exactly H=2.0 and fail below', () => {
      const base = { word_count: 20, unique_words: 15, avg_word_length: 4.0, most_frequent: [1, 2, 3] };
      const atThreshold = checkWordStats({ ...base, entropy: 2.0 });
      expect(atThreshold.checks.find(c => c.name === 'lexical_entropy')?.passed).toBe(true);

      const below = checkWordStats({ ...base, entropy: 1.9 });
      expect(below.checks.find(c => c.name === 'lexical_entropy')?.passed).toBe(false);
    });

    it('should fail lexical_entropy when entropy is missing (repetitive or legacy output)', () => {
      const ws = { word_count: 20, unique_words: 15, avg_word_length: 4.0, most_frequent: [1, 2, 3] };
      const result = checkWordStats(ws);
      expect(result.checks.find(c => c.name === 'lexical_entropy')?.passed).toBe(false);
    });

    it('should pass balanced_length for avg 5.0', () => {
      const ws = { word_count: 10, unique_words: 8, avg_word_length: 5.0, most_frequent: [1] };
      const result = checkWordStats(ws);
      const check = result.checks.find(c => c.name === 'balanced_length');
      expect(check?.passed).toBe(true);
    });

    it('should return quality 0 for undefined word stats', () => {
      const result = checkWordStats(undefined);
      expect(result.quality).toBe(0);
      expect(result.checks).toHaveLength(0);
    });

    it('should pass all checks for perfect caesar cipher roundtrip', () => {
      const input = 'hello world';
      const cc = { encrypted: 'uryyb jbeyq', decrypted: 'hello world' };
      const result = checkCaesarCipher(cc, input);
      expect(result.quality).toBe(100);
      expect(result.checks).toHaveLength(4);
      expect(result.checks.every(c => c.passed)).toBe(true);
    });

    it('should return quality 0 for undefined caesar cipher', () => {
      const result = checkCaesarCipher(undefined, 'test');
      expect(result.quality).toBe(0);
      expect(result.checks).toHaveLength(0);
    });

    it('should fail char_shift_valid for a transform that roundtrips without shifting', () => {
      // A string reversal "roundtrips" but is not a Caesar cipher
      const input = 'hello world';
      const cc = { encrypted: 'dlrow olleh', decrypted: 'hello world' };
      const result = checkCaesarCipher(cc, input);
      const charCheck = result.checks.find(c => c.name === 'char_shift_valid');
      expect(charCheck?.passed).toBe(false);
      expect(result.quality).toBe(75); // produced_output ✓, roundtrip ✓, transformed ✓, char_shift ✗
    });

    it('should fail char_shift_valid on length mismatch or a single wrong character', () => {
      const truncated = checkCaesarCipher({ encrypted: 'uryyb', decrypted: 'hello world' }, 'hello world');
      expect(truncated.checks.find(c => c.name === 'char_shift_valid')?.passed).toBe(false);

      // One character off (last char should be 'q' for ROT13 of 'd')
      const oneOff = checkCaesarCipher({ encrypted: 'uryyb jbeyd', decrypted: 'hello world' }, 'hello world');
      expect(oneOff.checks.find(c => c.name === 'char_shift_valid')?.passed).toBe(false);
    });

    it('should preserve case and pass punctuation through in char verification', () => {
      const input = 'Hello, World!';
      const cc = { encrypted: 'Uryyb, Jbeyq!', decrypted: 'Hello, World!' };
      const result = checkCaesarCipher(cc, input);
      expect(result.checks.find(c => c.name === 'char_shift_valid')?.passed).toBe(true);
      expect(result.quality).toBe(100);
    });

    it('should pass all checks when all 4 pattern categories found', () => {
      const p = { emails: ['a@b.com'], urls: ['https://x.com'], numbers: ['42'], dates: ['2026-01-01'] };
      const result = checkPatterns(p);
      expect(result.quality).toBe(100);
      expect(result.checks).toHaveLength(4);
      expect(result.checks.every(c => c.passed)).toBe(true);
    });

    it('should give quality 50 for 2/4 pattern categories', () => {
      const p = { emails: ['a@b.com'], urls: [], numbers: ['42'], dates: [] };
      const result = checkPatterns(p);
      expect(result.quality).toBe(50);
      const passed = result.checks.filter(c => c.passed);
      expect(passed).toHaveLength(2);
    });

    it('should pass all checks for positive input with sufficient words', () => {
      const s = { score: 1.0, label: 'positive', positive: ['great', 'good'], negative: [], negated: [] };
      const result = checkSentiment(s, 'great and good stuff');
      // detected_sentiment: ✓, found_words: ✓, sufficient_evidence: 2>=2 ✓, has_confidence: ✓, negation_handled: 0=0 ✓
      expect(result.quality).toBe(100);
      const evidenceCheck = result.checks.find(c => c.name === 'sufficient_evidence');
      expect(evidenceCheck?.passed).toBe(true);
    });

    it('should fail sufficient_evidence with only 1 sentiment word', () => {
      const s = { score: 1.0, label: 'positive', positive: ['great'], negative: [] };
      const result = checkSentiment(s);
      // detected_sentiment: ✓, found_words: ✓, sufficient_evidence: 1<2 ✗, has_confidence: ✓, negation_handled: 0=0 ✓
      expect(result.quality).toBe(80);
      const evidenceCheck = result.checks.find(c => c.name === 'sufficient_evidence');
      expect(evidenceCheck?.passed).toBe(false);
    });

    it('should give quality 20 for neutral sentiment with no words (only vacuous negation check passes)', () => {
      const s = { score: 0, label: 'neutral', positive: [], negative: [] };
      const result = checkSentiment(s);
      expect(result.quality).toBe(20);
      const failed = result.checks.filter(c => !c.passed).map(c => c.name);
      expect(failed).toEqual(['detected_sentiment', 'found_words', 'sufficient_evidence', 'has_confidence']);
    });

    it('should pass negation_handled when reported flips match the input', () => {
      // "not good" — analyzer flipped 'good' to negative and reported it
      const s = { score: -1.0, label: 'negative', positive: [], negative: ['good', 'terrible'], negated: ['good'] };
      const result = checkSentiment(s, 'this is not good and quite terrible');
      const negationCheck = result.checks.find(c => c.name === 'negation_handled');
      expect(negationCheck?.passed).toBe(true);
      expect(result.quality).toBe(100);
    });

    it('should fail negation_handled when the analyzer missed a flip', () => {
      // Input contains "not good" but the analyzer reported no negations
      const s = { score: 1.0, label: 'positive', positive: ['good', 'great'], negative: [] };
      const result = checkSentiment(s, 'not good but great');
      const negationCheck = result.checks.find(c => c.name === 'negation_handled');
      expect(negationCheck?.passed).toBe(false);
      expect(result.quality).toBe(80);
    });

    it('generated analyzeSentiment applies intensity weights (executed, not recomputed)', () => {
      // Extract the REAL generated method from the catalog output and run it
      const gen4 = EVOLUTION_CATALOG[3].apply(getAgentSource(), 4);
      // lastIndexOf: the first occurrence is the unevaluated template inside
      // the catalog source; the spliced (interpolated) copy comes later
      const start = gen4.lastIndexOf('analyzeSentiment(text) {');
      expect(start).toBeGreaterThan(-1);
      let depth = 0, end = start;
      for (let i = gen4.indexOf('{', start); i < gen4.length; i++) {
        if (gen4[i] === '{') depth++;
        if (gen4[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      const analyze = new Function(`return function ${gen4.slice(start, end)}`)() as (text: string) => {
        score: number; label: string; positive: string[]; negative: string[]; negated: string[];
      };

      // "amazing" (1.0) outweighs "bad" (-0.5): equal counts, positive verdict
      const mixed = analyze('amazing but bad');
      expect(mixed.score).toBeCloseTo(0.33, 2);
      expect(mixed.label).toBe('positive');

      // Equal tiers cancel exactly
      expect(analyze('good but bad').label).toBe('neutral');

      // Three milds (+1.5) barely offset one strong (-1.0): 0.5/2.5 = 0.2 → not > 0.2
      expect(analyze('good good good but terrible').label).toBe('neutral');

      // Negation flips the weighted contribution
      const negatedResult = analyze('not amazing');
      expect(negatedResult.negated).toEqual(['amazing']);
      expect(negatedResult.label).toBe('negative');
      expect(negatedResult.score).toBe(-1);
    });

    it('should count negated sentiment words with a 2-token window', () => {
      expect(countNegatedSentimentWords('not good')).toBe(1);
      expect(countNegatedSentimentWords('never really great')).toBe(1); // negator 2 tokens back
      expect(countNegatedSentimentWords('good and great')).toBe(0);
      expect(countNegatedSentimentWords('not so bad')).toBe(1);
      expect(countNegatedSentimentWords('the food was not good and never great')).toBe(2);
      expect(countNegatedSentimentWords('')).toBe(0);
    });

    it('should pass all checks for correct Gen 5 reflection', () => {
      const r = { generation: 5, identity: 'I am Gen5', className: 'OuroborosGen5Agent', capability_count: 8 };
      const result = checkReflection(r);
      expect(result.quality).toBe(100);
      expect(result.checks).toHaveLength(4);
      expect(result.checks.every(c => c.passed)).toBe(true);
    });

    it('should fail 2 checks for wrong generation in reflection', () => {
      const r = { generation: 3, identity: 'I am Gen3', className: 'OuroborosGen3Agent', capability_count: 5 };
      const result = checkReflection(r);
      // correct_generation: false, knows_identity: true, correct_class: false, counted_capabilities: true
      expect(result.quality).toBe(50);
      const genCheck = result.checks.find(c => c.name === 'correct_generation');
      expect(genCheck?.passed).toBe(false);
      const classCheck = result.checks.find(c => c.name === 'correct_class');
      expect(classCheck?.passed).toBe(false);
    });

    it('should include check details with each check', () => {
      const ws = { word_count: 50, unique_words: 50, avg_word_length: 5.0, most_frequent: [1, 2, 3, 4, 5] };
      const result = checkWordStats(ws);
      for (const check of result.checks) {
        expect(check.name).toBeDefined();
        expect(typeof check.passed).toBe('boolean');
        expect(check.detail.length).toBeGreaterThan(0);
      }
    });
  });

  describe('assessEvolution', () => {
    const sampleCaps: Record<string, unknown> = {
      wordStats: { word_count: 15, unique_words: 12, avg_word_length: 4.5, most_frequent: [{ word: 'the', count: 3 }, { word: 'fox', count: 2 }] },
      caesarCipher: { encrypted: 'Gur nznmvat sbk', decrypted: 'The amazing fox' },
      patterns: { emails: ['test@example.com'], urls: ['https://test.dev'], numbers: [], dates: ['2026-01-15'] },
      sentiment: { score: 1.0, label: 'positive', positive: ['amazing', 'great'], negative: [] },
      reflection: { generation: 5, className: 'OuroborosGen5Agent', capabilities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], capability_count: 8, identity: 'I am OuroborosGen5Agent, generation 5. I have 8 methods.' },
    };

    it('should produce valid report from real capabilities', async () => {
      const report = await assessEvolution('The amazing fox', sampleCaps);
      expect(report.capabilities).toHaveLength(5);
      expect(report.overall_quality).toBeGreaterThanOrEqual(0);
      expect(report.overall_quality).toBeLessThanOrEqual(100);
      expect(['strong', 'developing', 'weak']).toContain(report.status);
      expect(report.formatted).toContain('EVOLUTION REPORT');

      for (const cap of report.capabilities) {
        expect(cap.quality).toBeGreaterThanOrEqual(0);
        expect(cap.quality).toBeLessThanOrEqual(100);
        expect(['strong', 'developing', 'weak']).toContain(cap.status);
        expect(Array.isArray(cap.checks)).toBe(true);
        expect(cap.summary.length).toBeGreaterThan(0);
      }
    });

    it('should use deterministic mode when no provider given', async () => {
      const report = await assessEvolution('test', sampleCaps);
      expect(report.judge_mode).toBe('deterministic');
    });

    it('should use hybrid mode with mock provider', async () => {
      const mockProvider: LLMProvider = {
        id: 'mock',
        name: 'Mock Provider',
        async isAvailable() { return true; },
        async chat() {
          return {
            content: JSON.stringify([
              'Word stats show comprehensive vocabulary analysis.',
              'Caesar cipher achieves perfect roundtrip encryption.',
              'Pattern detection covers most categories effectively.',
              'Sentiment analysis could benefit from wider word range.',
              'Self-reflection accurately identifies all capabilities.',
            ]),
            tool_calls: null,
          } satisfies ProviderResponse;
        },
      };

      const report = await assessEvolution('test', sampleCaps, mockProvider);
      expect(report.judge_mode).toBe('hybrid');
      expect(report.capabilities[0].summary).toContain('Word stats');
    });

    it('should fall back to deterministic if provider throws', async () => {
      const failProvider: LLMProvider = {
        id: 'fail',
        name: 'Fail Provider',
        async isAvailable() { return true; },
        async chat() { throw new Error('provider exploded'); },
      };

      const report = await assessEvolution('test', sampleCaps, failProvider);
      expect(report.judge_mode).toBe('deterministic');
      // Summaries should still exist (deterministic fallback)
      for (const cap of report.capabilities) {
        expect(cap.summary.length).toBeGreaterThan(0);
      }
    });

    it('should have null lineage on first run (no prior runs)', async () => {
      const report = await assessEvolution('test', sampleCaps);
      expect(report.lineage).toBeNull();
    });

    it('should have null lineage with empty prior runs', async () => {
      const report = await assessEvolution('test', sampleCaps, undefined, []);
      expect(report.lineage).toBeNull();
    });

    it('should compute lineage from prior run summaries', async () => {
      const priorRuns: LineageRunSummary[] = [{
        run_number: 1,
        timestamp: '2026-01-01T00:00:00Z',
        input_hash: 'abc123',
        overall_quality: 40,
        status: 'weak',
        level_qualities: [30, 25, 20, 10, 40],
        level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'],
      }];

      const report = await assessEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(report.lineage).not.toBeNull();
      const lineage = report.lineage!;
      expect(lineage.run_number).toBe(2);
      expect(lineage.prior_quality).toBe(40);
      expect(lineage.prior_status).toBe('weak');
      expect(lineage.deltas).toHaveLength(5);
      expect(lineage.cumulative_runs).toBe(2);
      expect(lineage.history).toHaveLength(1);
      expect(typeof lineage.trajectory).toBe('number');
      expect(['improving', 'stable', 'declining']).toContain(lineage.trend);

      for (const d of lineage.deltas) {
        expect(d.capability.length).toBeGreaterThan(0);
        expect(typeof d.quality_delta).toBe('number');
        expect(typeof d.status_change).toBe('string');
      }
    });

    it('should track improving trend when current scores exceed prior', async () => {
      const priorRuns: LineageRunSummary[] = [{
        run_number: 1,
        timestamp: '2026-01-01T00:00:00Z',
        input_hash: 'abc123',
        overall_quality: 10,
        status: 'weak',
        level_qualities: [5, 5, 5, 5, 5],
        level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'],
      }];

      const report = await assessEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(report.lineage!.trend).toBe('improving');
    });

    it('should compute trajectory from 3+ data points', async () => {
      const priorRuns: LineageRunSummary[] = [
        { run_number: 1, timestamp: '2026-01-01T00:00:00Z', input_hash: 'a', overall_quality: 20, status: 'weak', level_qualities: [20, 20, 20, 20, 20], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 2, timestamp: '2026-01-02T00:00:00Z', input_hash: 'b', overall_quality: 30, status: 'weak', level_qualities: [30, 30, 30, 30, 30], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 3, timestamp: '2026-01-03T00:00:00Z', input_hash: 'c', overall_quality: 35, status: 'weak', level_qualities: [35, 35, 35, 35, 35], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
      ];

      const report = await assessEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(report.lineage).not.toBeNull();
      expect(report.lineage!.history).toHaveLength(3);
      expect(typeof report.lineage!.trajectory).toBe('number');
      // With 3 prior runs at 20, 30, 35 plus current (high quality caps), trajectory should be positive
      expect(report.lineage!.trajectory).toBeGreaterThan(0);
    });

    it('should pass lineage context to LLM enhancement prompt', async () => {
      let capturedPrompt = '';
      const captureProvider: LLMProvider = {
        id: 'capture',
        name: 'Capture Provider',
        async isAvailable() { return true; },
        async chat(messages) {
          capturedPrompt = messages[0].content;
          return {
            content: JSON.stringify([
              'Suggestion 1', 'Suggestion 2', 'Suggestion 3', 'Suggestion 4', 'Suggestion 5',
            ]),
            tool_calls: null,
          };
        },
      };

      const priorRuns: LineageRunSummary[] = [
        { run_number: 1, timestamp: '2026-01-01T00:00:00Z', input_hash: 'a', overall_quality: 100, status: 'strong', level_qualities: [100, 100, 100, 100, 100], level_statuses: ['strong', 'strong', 'strong', 'strong', 'strong'] },
        { run_number: 2, timestamp: '2026-01-02T00:00:00Z', input_hash: 'b', overall_quality: 95, status: 'strong', level_qualities: [95, 95, 95, 95, 95], level_statuses: ['strong', 'strong', 'strong', 'strong', 'strong'] },
        { run_number: 3, timestamp: '2026-01-03T00:00:00Z', input_hash: 'c', overall_quality: 90, status: 'strong', level_qualities: [90, 90, 90, 90, 90], level_statuses: ['strong', 'strong', 'strong', 'strong', 'strong'] },
      ];

      await assessEvolution('The amazing fox', sampleCaps, captureProvider, priorRuns);
      expect(capturedPrompt).toContain('run #4');
      expect(capturedPrompt).toContain('Trajectory');
      // Should detect declining (100→95→90→current ~90, steep enough for negative trajectory)
      expect(capturedPrompt.toLowerCase()).toContain('declining');
    });
  });

  describe('input difficulty scoring', () => {
    it('rates rich input as fair for all capabilities', () => {
      const input = 'The amazing wonderful fox jumped over seven lazy dogs today. ' +
        'Email test@example.com or visit https://example.com by 2026-01-15, item 42.';
      const difficulty = scoreInputDifficulty(input);
      expect(difficulty).toHaveLength(5);
      for (const d of difficulty) {
        expect(d.fair).toBe(true);
        expect(d.reasons).toEqual([]);
      }
    });

    it('flags short input as unfair to word statistics', () => {
      const difficulty = scoreInputDifficulty('great amazing fox');
      const wordStats = difficulty.find(d => d.capability === 'Word Statistics')!;
      expect(wordStats.fair).toBe(false);
      expect(wordStats.reasons.join(' ')).toContain('3 words');
    });

    it('flags repetitive input as unfair to entropy even when long enough', () => {
      const difficulty = scoreInputDifficulty('go go go go go stop stop stop stop stop');
      const wordStats = difficulty.find(d => d.capability === 'Word Statistics')!;
      expect(wordStats.fair).toBe(false);
      expect(wordStats.reasons.join(' ')).toContain('unique words');
    });

    it('flags non-alphabetic input as unfair to the cipher', () => {
      const difficulty = scoreInputDifficulty('123 456 789');
      const cipher = difficulty.find(d => d.capability === 'Caesar Cipher')!;
      expect(cipher.fair).toBe(false);
      expect(cipher.reasons).toEqual(['no alphabetic characters to shift']);
    });

    it('lists exactly the missing pattern categories', () => {
      const difficulty = scoreInputDifficulty('Email test@example.com with item 42 today');
      const patterns = difficulty.find(d => d.capability === 'Pattern Detection')!;
      expect(patterns.fair).toBe(false);
      expect(patterns.reasons).toEqual(['no urls', 'no dates']);
    });

    it('flags sentiment-free input as unfair to the sentiment heuristic', () => {
      const difficulty = scoreInputDifficulty('the quick brown fox jumps over the lazy sleeping dog');
      const sentiment = difficulty.find(d => d.capability === 'Sentiment Heuristic')!;
      expect(sentiment.fair).toBe(false);
      expect(sentiment.reasons.join(' ')).toContain('0 sentiment-bearing words');
    });

    it('always rates reflection as fair (input-independent)', () => {
      for (const input of ['', '123', 'x']) {
        const reflection = scoreInputDifficulty(input).find(d => d.capability === 'Self-Reflection')!;
        expect(reflection.fair).toBe(true);
      }
    });

    it('includes input_difficulty in the assessEvolution report', async () => {
      const report = await assessEvolution('12345', {
        wordStats: { word_count: 0, unique_words: 0, avg_word_length: 0, most_frequent: [] },
      });
      expect(report.input_difficulty).toHaveLength(5);
      const wordStats = report.input_difficulty.find(d => d.capability === 'Word Statistics')!;
      // Weak word-stats score on numeric input is attributable to unfair input
      expect(wordStats.fair).toBe(false);
    });
  });

  describe('per-capability trajectories', () => {
    const mkRun = (n: number, levels: number[]): LineageRunSummary => ({
      run_number: n,
      timestamp: '',
      input_hash: String(n),
      overall_quality: Math.round(levels.reduce((s, q) => s + q, 0) / levels.length),
      status: 'developing',
      level_qualities: levels,
      level_statuses: levels.map(() => 'developing'),
    });

    it('computes an independent slope per capability', () => {
      // Capability 0 rises steeply, capability 1 falls, the rest stay flat
      const runs = [
        mkRun(1, [10, 90, 50, 50, 50]),
        mkRun(2, [30, 70, 50, 50, 50]),
        mkRun(3, [50, 50, 50, 50, 50]),
        mkRun(4, [70, 30, 50, 50, 50]),
      ];
      const trajectories = computeCapabilityTrajectories(runs);
      expect(trajectories).toHaveLength(5);
      expect(trajectories[0].slope).toBe(20);
      expect(trajectories[0].direction).toBe('improving');
      expect(trajectories[0].significant).toBe(true);
      expect(trajectories[1].slope).toBe(-20);
      expect(trajectories[1].direction).toBe('declining');
      expect(trajectories[2].slope).toBe(0);
      expect(trajectories[2].direction).toBe('stable');
    });

    it('gates direction on confidence: noisy history reads as stable', () => {
      // Zigzag with a tiny net slope — high standard error, not significant
      const runs = [
        mkRun(1, [50, 50, 50, 50, 50]),
        mkRun(2, [90, 50, 50, 50, 50]),
        mkRun(3, [20, 50, 50, 50, 50]),
        mkRun(4, [85, 50, 50, 50, 50]),
        mkRun(5, [30, 50, 50, 50, 50]),
      ];
      const trajectories = computeCapabilityTrajectories(runs);
      expect(trajectories[0].significant).toBe(false);
      expect(trajectories[0].direction).toBe('stable');
    });

    it('never reports a direction with fewer than 3 data points', () => {
      const runs = [mkRun(1, [10, 10, 10, 10, 10]), mkRun(2, [90, 90, 90, 90, 90])];
      const trajectories = computeCapabilityTrajectories(runs);
      for (const t of trajectories) {
        expect(t.significant).toBe(false);
        expect(t.direction).toBe('stable');
        expect(t.std_error).toBe(-1);
      }
    });

    it('includes capability_trajectories in lineage from assessEvolution', async () => {
      const sampleCaps: Record<string, unknown> = {
        wordStats: { word_count: 15, unique_words: 12, avg_word_length: 4.5, most_frequent: [{ word: 'the', count: 3 }], entropy: 3.1 },
        caesarCipher: { encrypted: 'Gur nznmvat sbk', decrypted: 'The amazing fox' },
        patterns: { emails: ['test@example.com'], urls: [], numbers: [], dates: [] },
        sentiment: { score: 1.0, label: 'positive', positive: ['amazing', 'great'], negative: [] },
        reflection: { generation: 5, className: 'OuroborosGen5Agent', capabilities: [], capability_count: 8, identity: 'I am Gen5' },
      };
      const priorRuns = [
        mkRun(1, [20, 20, 20, 20, 20]),
        mkRun(2, [40, 40, 40, 40, 40]),
        mkRun(3, [60, 60, 60, 60, 60]),
      ];

      const report = await assessEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(report.lineage).not.toBeNull();
      const trajectories = report.lineage!.capability_trajectories;
      expect(trajectories).toHaveLength(5);
      for (const t of trajectories) {
        expect(typeof t.slope).toBe('number');
        expect(typeof t.significant).toBe('boolean');
        expect(['improving', 'declining', 'stable']).toContain(t.direction);
      }
    });
  });

  describe('capability trends', () => {
    it('should return neutral trends for fewer than 3 prior runs', () => {
      const runs: LineageRunSummary[] = [
        { run_number: 1, timestamp: '', input_hash: 'a', overall_quality: 50, status: 'developing', level_qualities: [50, 50, 50, 50, 50], level_statuses: ['developing', 'developing', 'developing', 'developing', 'developing'] },
        { run_number: 2, timestamp: '', input_hash: 'b', overall_quality: 55, status: 'developing', level_qualities: [55, 55, 55, 55, 55], level_statuses: ['developing', 'developing', 'developing', 'developing', 'developing'] },
      ];
      const trends = computeTrends(runs);
      // With only 2 runs, max consecutive is 1 — no trend kicks in
      for (const t of trends) {
        expect(t.multiplier).toBe(1.0);
        expect(t.direction).toBeNull();
      }
    });

    it('should detect improving trend for 3+ consecutive improvements', () => {
      const runs: LineageRunSummary[] = [
        { run_number: 1, timestamp: '', input_hash: 'a', overall_quality: 20, status: 'weak', level_qualities: [20, 20, 20, 20, 20], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 2, timestamp: '', input_hash: 'b', overall_quality: 40, status: 'weak', level_qualities: [40, 40, 40, 40, 40], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 3, timestamp: '', input_hash: 'c', overall_quality: 60, status: 'developing', level_qualities: [60, 60, 60, 60, 60], level_statuses: ['developing', 'developing', 'developing', 'developing', 'developing'] },
        { run_number: 4, timestamp: '', input_hash: 'd', overall_quality: 80, status: 'strong', level_qualities: [80, 80, 80, 80, 80], level_statuses: ['strong', 'strong', 'strong', 'strong', 'strong'] },
      ];
      const trends = computeTrends(runs);
      for (const t of trends) {
        expect(t.consecutive).toBe(3);
        expect(t.direction).toBe('improving');
        expect(t.multiplier).toBeGreaterThan(1.0);
      }
    });

    it('should detect declining trend for 3+ consecutive declines', () => {
      const runs: LineageRunSummary[] = [
        { run_number: 1, timestamp: '', input_hash: 'a', overall_quality: 80, status: 'strong', level_qualities: [80, 80, 80, 80, 80], level_statuses: ['strong', 'strong', 'strong', 'strong', 'strong'] },
        { run_number: 2, timestamp: '', input_hash: 'b', overall_quality: 60, status: 'developing', level_qualities: [60, 60, 60, 60, 60], level_statuses: ['developing', 'developing', 'developing', 'developing', 'developing'] },
        { run_number: 3, timestamp: '', input_hash: 'c', overall_quality: 40, status: 'weak', level_qualities: [40, 40, 40, 40, 40], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 4, timestamp: '', input_hash: 'd', overall_quality: 20, status: 'weak', level_qualities: [20, 20, 20, 20, 20], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
      ];
      const trends = computeTrends(runs);
      for (const t of trends) {
        expect(t.consecutive).toBe(3);
        expect(t.direction).toBe('declining');
        expect(t.multiplier).toBeLessThan(1.0);
      }
    });

    it('should apply improving multiplier to quality in report', async () => {
      const improvingRuns: LineageRunSummary[] = [
        { run_number: 1, timestamp: '', input_hash: 'a', overall_quality: 20, status: 'weak', level_qualities: [10, 10, 10, 10, 10], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 2, timestamp: '', input_hash: 'b', overall_quality: 30, status: 'weak', level_qualities: [20, 20, 20, 20, 20], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 3, timestamp: '', input_hash: 'c', overall_quality: 40, status: 'weak', level_qualities: [30, 30, 30, 30, 30], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 4, timestamp: '', input_hash: 'd', overall_quality: 50, status: 'developing', level_qualities: [40, 40, 40, 40, 40], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
      ];

      const sampleCaps: Record<string, unknown> = {
        wordStats: { word_count: 15, unique_words: 12, avg_word_length: 4.5, most_frequent: [{ word: 'the', count: 3 }, { word: 'fox', count: 2 }] },
        caesarCipher: { encrypted: 'Gur nznmvat sbk', decrypted: 'The amazing fox' },
        patterns: { emails: ['test@example.com'], urls: ['https://test.dev'], numbers: [], dates: ['2026-01-15'] },
        sentiment: { score: 1.0, label: 'positive', positive: ['amazing', 'great'], negative: [] },
        reflection: { generation: 5, className: 'OuroborosGen5Agent', capabilities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], capability_count: 8, identity: 'I am OuroborosGen5Agent, generation 5. I have 8 methods.' },
      };

      // With trends
      const withTrends = await assessEvolution('The amazing fox', sampleCaps, undefined, improvingRuns);
      // Without trends
      const withoutTrends = await assessEvolution('The amazing fox', sampleCaps, undefined, []);

      // At least one capability should have boosted quality
      let foundBoosted = false;
      for (let i = 0; i < 5; i++) {
        const withT = withTrends.capabilities[i];
        const withoutT = withoutTrends.capabilities[i];
        if (withT.quality > withoutT.quality) {
          foundBoosted = true;
          expect(withT.base_quality).toBe(withoutT.base_quality); // raw checks identical
          expect(withT.trend?.direction).toBe('improving');
        }
      }
      expect(foundBoosted).toBe(true);
    });

    it('should include trend info in formatted report', async () => {
      const runs: LineageRunSummary[] = [
        { run_number: 1, timestamp: '', input_hash: 'a', overall_quality: 20, status: 'weak', level_qualities: [10, 10, 10, 10, 10], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 2, timestamp: '', input_hash: 'b', overall_quality: 30, status: 'weak', level_qualities: [20, 20, 20, 20, 20], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 3, timestamp: '', input_hash: 'c', overall_quality: 40, status: 'weak', level_qualities: [30, 30, 30, 30, 30], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
        { run_number: 4, timestamp: '', input_hash: 'd', overall_quality: 50, status: 'developing', level_qualities: [40, 40, 40, 40, 40], level_statuses: ['weak', 'weak', 'weak', 'weak', 'weak'] },
      ];

      const sampleCaps: Record<string, unknown> = {
        wordStats: { word_count: 15, unique_words: 12, avg_word_length: 4.5, most_frequent: [{ word: 'the', count: 3 }] },
        caesarCipher: { encrypted: 'test', decrypted: 'test' },
        patterns: { emails: ['a@b.com'], urls: [], numbers: [], dates: [] },
        sentiment: { score: 0.5, label: 'positive', positive: ['good'], negative: [] },
        reflection: { generation: 5, className: 'OuroborosGen5Agent', capabilities: [], capability_count: 5, identity: 'test' },
      };

      const report = await assessEvolution('test', sampleCaps, undefined, runs);
      expect(report.formatted).toContain('improving');
    });
  });

  describe('full cycle with report', () => {
    let result: Record<string, unknown>;
    let workDir: string;

    beforeAll(async () => {
      workDir = join(testWorkDir, `report-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const input = 'The amazing fox is great. Email: test@example.com, URL: https://test.dev, Date: 2026-01-15';
      const resultStr = await agent.execute({ input });
      result = JSON.parse(resultStr);
    }, 30000);

    it('should include report in final output', () => {
      expect(result.report).toBeDefined();
      const rpt = result.report as EvolutionReport;
      expect(rpt.capabilities).toHaveLength(5);
      expect(rpt.formatted).toContain('EVOLUTION REPORT');
      expect(rpt.overall_quality).toBeGreaterThan(0);
    });

    it('should have valid quality and status', () => {
      const rpt = result.report as EvolutionReport;
      expect(rpt.overall_quality).toBeGreaterThan(0);
      expect(rpt.overall_quality).toBeLessThanOrEqual(100);
      expect(['strong', 'developing', 'weak']).toContain(rpt.status);
    });

    it('should use deterministic judge mode without provider', () => {
      const rpt = result.report as EvolutionReport;
      expect(rpt.judge_mode).toBe('deterministic');
    });

    it('should also include report on cached runs', async () => {
      // Second run uses cache — should still have report
      const agent2 = new OuroborosAgent(workDir);
      const result2Str = await agent2.execute({ input: 'cached run test' });
      const result2 = JSON.parse(result2Str);
      expect(result2.report).toBeDefined();
      const rpt = result2.report as EvolutionReport;
      expect(rpt.capabilities).toHaveLength(5);
      expect(rpt.overall_quality).toBeGreaterThanOrEqual(0);
    }, 30000);
  });

  describe('persistence cache', () => {
    it('should write .cache-meta.json after first evolution', async () => {
      const workDir = join(testWorkDir, `cache-write-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      await agent.execute({ input: 'cache test' });

      const metaPath = join(workDir, '.cache-meta.json');
      expect(existsSync(metaPath)).toBe(true);

      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      expect(meta.sourceHash).toBeDefined();
      expect(typeof meta.sourceHash).toBe('string');
      expect(meta.sourceHash).toMatch(/^[0-9a-f]{16}$/);
      expect(meta.basicAgentPath).toBeDefined();
      expect(meta.ext).toBeDefined();
      expect(meta.createdAt).toBeDefined();
    }, 30000);

    it('should use cache on second run with same workDir', async () => {
      const workDir = join(testWorkDir, `cache-hit-${Date.now()}`);

      // First run: full evolution
      const agent1 = new OuroborosAgent(workDir);
      const result1Str = await agent1.execute({ input: 'first run' });
      const result1 = JSON.parse(result1Str);
      expect(result1.status).toBe('success');

      // Second run: should hit cache
      const agent2 = new OuroborosAgent(workDir);
      const result2Str = await agent2.execute({ input: 'second run' });
      const result2 = JSON.parse(result2Str);
      expect(result2.status).toBe('success');

      // Verify cache hit appears in evolution log
      const log = result2.evolution_log as string[];
      expect(log.some((line: string) => line.includes('cache hit'))).toBe(true);

      // Capabilities should still work
      const caps = result2.capabilities_output as Record<string, unknown>;
      expect(caps.wordStats).toBeDefined();
      expect(caps.caesarCipher).toBeDefined();
      expect(caps.patterns).toBeDefined();
      expect(caps.sentiment).toBeDefined();
      expect(caps.reflection).toBeDefined();
    }, 60000);

    it('should invalidate cache when source hash changes', async () => {
      const workDir = join(testWorkDir, `cache-invalidate-${Date.now()}`);

      // First run: full evolution, writes cache
      const agent1 = new OuroborosAgent(workDir);
      await agent1.execute({ input: 'first' });

      // Tamper with the cache meta to simulate changed source
      const metaPath = join(workDir, '.cache-meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      meta.sourceHash = 'aaaaaaaaaaaaaaaa'; // Wrong hash
      writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      // Second run: should NOT hit cache (hash mismatch → re-evolve)
      const agent2 = new OuroborosAgent(workDir);
      const result2Str = await agent2.execute({ input: 'second' });
      const result2 = JSON.parse(result2Str);
      const log = result2.evolution_log as string[];
      expect(log.some((line: string) => line.includes('cache hit'))).toBe(false);
      expect(result2.status).toBe('success');
    }, 60000);
  });
});
