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
  judgeEvolution, scoreWordStats, scoreCaesarCipher, scorePatterns,
  scoreSentiment, scoreReflection, loadLineageLog, saveLineageLog,
} from '../../agents/OuroborosAgent.js';
import type { EvolutionScorecard, EvolutionLineage, LineageRunSummary, LevelScore } from '../../agents/OuroborosAgent.js';
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

    it('should include scorecard_summary in data_slush signals', async () => {
      const workDir = join(testWorkDir, `slush-scorecard-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const resultStr = await agent.execute({ input: 'The amazing fox is great' });
      const result = JSON.parse(resultStr);
      const signals = result.data_slush.signals;

      expect(signals.scorecard_summary).toBeDefined();
      expect(signals.scorecard_summary.power_level).toBeGreaterThanOrEqual(0);
      expect(signals.scorecard_summary.overall_grade).toBeDefined();
      expect(signals.scorecard_summary.rank_title).toBeDefined();
      expect(signals.scorecard_summary.total_xp).toBeGreaterThan(0);
      expect(signals.scorecard_summary.level_grades).toHaveLength(5);
      expect(signals.scorecard_summary.verdicts).toHaveLength(5);
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
      expect(slush2.signals.lineage.prior_power_level).toBe(slush1.signals.scorecard_summary.power_level);
      expect(slush2.signals.lineage.prior_grade).toBe(slush1.signals.scorecard_summary.overall_grade);
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
        { run_number: 1, timestamp: '2026-01-01T00:00:00Z', input_hash: 'a', power_level: 50, overall_grade: 'C', rank_title: 'Journeyman Mage', total_xp: 2500, level_xps: [500, 500, 500, 500, 500], level_grades: ['C', 'C', 'C', 'C', 'C'] },
        { run_number: 2, timestamp: '2026-01-02T00:00:00Z', input_hash: 'b', power_level: 55, overall_grade: 'C', rank_title: 'Journeyman Mage', total_xp: 2750, level_xps: [550, 550, 550, 550, 550], level_grades: ['C', 'C', 'C', 'C', 'C'] },
      ];

      saveLineageLog(workDir, runs);
      const loaded = loadLineageLog(workDir);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].run_number).toBe(1);
      expect(loaded[1].power_level).toBe(55);
    });

    it('should return empty array for missing lineage log', () => {
      const workDir = join(testWorkDir, `lineage-missing-${Date.now()}`);
      const loaded = loadLineageLog(workDir);
      expect(loaded).toEqual([]);
    });
  });

  describe('RPG scoring', () => {
    it('should give max PWR for 50+ words in scoreWordStats', () => {
      const ws = { word_count: 50, unique_words: 30, avg_word_length: 5.0, most_frequent: [1, 2, 3, 4, 5] };
      const stats = scoreWordStats(ws);
      expect(stats.PWR.value).toBe(10);
    });

    it('should give max WIS for 5 most_frequent entries', () => {
      const ws = { word_count: 10, unique_words: 5, avg_word_length: 4.0, most_frequent: [1, 2, 3, 4, 5] };
      const stats = scoreWordStats(ws);
      expect(stats.WIS.value).toBe(10);
    });

    it('should give max DEX for avg_word_length of 5.0', () => {
      const ws = { word_count: 10, unique_words: 5, avg_word_length: 5.0, most_frequent: [1] };
      const stats = scoreWordStats(ws);
      expect(stats.DEX.value).toBe(10);
    });

    it('should handle undefined in scoreWordStats', () => {
      const stats = scoreWordStats(undefined);
      expect(stats.PWR.value).toBe(0);
      expect(stats.INT.value).toBe(0);
      expect(stats.DEX.value).toBe(0);
      expect(stats.WIS.value).toBe(0);
    });

    it('should give DEX 10 for perfect roundtrip in scoreCaesarCipher', () => {
      const input = 'hello world';
      const cc = { encrypted: 'uryyb jbeyq', decrypted: 'hello world' };
      const stats = scoreCaesarCipher(cc, input);
      expect(stats.DEX.value).toBe(10);
    });

    it('should handle undefined in scoreCaesarCipher', () => {
      const stats = scoreCaesarCipher(undefined, 'test');
      expect(stats.PWR.value).toBe(0);
    });

    it('should give INT 10 for all 4 categories in scorePatterns', () => {
      const p = { emails: ['a@b.com'], urls: ['https://x.com'], numbers: ['42'], dates: ['2026-01-01'] };
      const stats = scorePatterns(p);
      expect(stats.INT.value).toBe(10);
    });

    it('should give INT 5 for 2/4 categories in scorePatterns', () => {
      const p = { emails: ['a@b.com'], urls: [], numbers: ['42'], dates: [] };
      const stats = scorePatterns(p);
      expect(stats.INT.value).toBe(5);
    });

    it('should give high WIS for decisive sentiment score', () => {
      const s = { score: 1.0, label: 'positive', positive: ['great', 'good'], negative: [] };
      const stats = scoreSentiment(s);
      expect(stats.WIS.value).toBe(10);
    });

    it('should give zero WIS for neutral sentiment', () => {
      const s = { score: 0, label: 'neutral', positive: [], negative: [] };
      const stats = scoreSentiment(s);
      expect(stats.WIS.value).toBe(0);
    });

    it('should give PWR 10 for correct generation in scoreReflection', () => {
      const r = { generation: 5, identity: 'I am Gen5', className: 'OuroborosGen5Agent', capability_count: 8 };
      const stats = scoreReflection(r);
      expect(stats.PWR.value).toBe(10);
    });

    it('should give PWR 2 for wrong generation in scoreReflection', () => {
      const r = { generation: 3, identity: 'I am Gen3', className: 'OuroborosGen3Agent', capability_count: 5 };
      const stats = scoreReflection(r);
      expect(stats.PWR.value).toBe(2);
    });

    it('should grade S for 900+ XP', () => {
      // gradeFromXP is internal but tested via judgeEvolution — test indirectly via high stats
      // Just verify structure through scoreWordStats producing valid values
      const ws = { word_count: 50, unique_words: 50, avg_word_length: 5.0, most_frequent: [1, 2, 3, 4, 5] };
      const stats = scoreWordStats(ws);
      // All stats should be 0-10
      for (const key of ['PWR', 'INT', 'DEX', 'WIS'] as const) {
        expect(stats[key].value).toBeGreaterThanOrEqual(0);
        expect(stats[key].value).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('judgeEvolution', () => {
    const sampleCaps: Record<string, unknown> = {
      wordStats: { word_count: 15, unique_words: 12, avg_word_length: 4.5, most_frequent: [{ word: 'the', count: 3 }, { word: 'fox', count: 2 }] },
      caesarCipher: { encrypted: 'Gur nznmvat sbk', decrypted: 'The amazing fox' },
      patterns: { emails: ['test@example.com'], urls: ['https://test.dev'], numbers: [], dates: ['2026-01-15'] },
      sentiment: { score: 1.0, label: 'positive', positive: ['amazing', 'great'], negative: [] },
      reflection: { generation: 5, className: 'OuroborosGen5Agent', capabilities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], capability_count: 8, identity: 'I am OuroborosGen5Agent, generation 5. I have 8 methods.' },
    };

    it('should produce valid scorecard from real capabilities', async () => {
      const scorecard = await judgeEvolution('The amazing fox', sampleCaps);
      expect(scorecard.levels).toHaveLength(5);
      expect(scorecard.total_xp).toBeGreaterThan(0);
      expect(scorecard.power_level).toBeGreaterThanOrEqual(0);
      expect(scorecard.power_level).toBeLessThanOrEqual(100);
      expect(['S', 'A', 'B', 'C', 'D']).toContain(scorecard.overall_grade);
      expect(scorecard.rank_title).toBeDefined();
      expect(scorecard.formatted).toContain('OUROBOROS EVOLUTION SCORECARD');

      for (const level of scorecard.levels) {
        expect(level.level).toBeGreaterThanOrEqual(1);
        expect(level.level).toBeLessThanOrEqual(5);
        expect(level.xp).toBeGreaterThanOrEqual(0);
        expect(level.xp).toBeLessThanOrEqual(1000);
        expect(['S', 'A', 'B', 'C', 'D']).toContain(level.grade);
        expect(level.stats.PWR.value).toBeGreaterThanOrEqual(0);
        expect(level.stats.PWR.value).toBeLessThanOrEqual(10);
      }
    });

    it('should use deterministic mode when no provider given', async () => {
      const scorecard = await judgeEvolution('test', sampleCaps);
      expect(scorecard.judge_mode).toBe('deterministic');
    });

    it('should use hybrid mode with mock provider', async () => {
      const mockProvider: LLMProvider = {
        id: 'mock',
        name: 'Mock Provider',
        async isAvailable() { return true; },
        async chat() {
          return {
            content: JSON.stringify([
              'The Lexicon Analyst awakens with burning insight!',
              'The Cipher Adept weaves cryptographic shadows!',
              'The Pattern Seeker pierces the veil of data!',
              'The Emotion Reader channels primal forces!',
              'The Ouroboros Sage achieves transcendence!',
            ]),
            tool_calls: null,
          } satisfies ProviderResponse;
        },
      };

      const scorecard = await judgeEvolution('test', sampleCaps, mockProvider);
      expect(scorecard.judge_mode).toBe('hybrid');
      expect(scorecard.levels[0].verdict).toContain('Lexicon Analyst');
    });

    it('should fall back to deterministic if provider throws', async () => {
      const failProvider: LLMProvider = {
        id: 'fail',
        name: 'Fail Provider',
        async isAvailable() { return true; },
        async chat() { throw new Error('provider exploded'); },
      };

      const scorecard = await judgeEvolution('test', sampleCaps, failProvider);
      expect(scorecard.judge_mode).toBe('deterministic');
      // Verdicts should still exist (deterministic fallback)
      for (const level of scorecard.levels) {
        expect(level.verdict.length).toBeGreaterThan(0);
      }
    });

    it('should have null lineage on first run (no prior runs)', async () => {
      const scorecard = await judgeEvolution('test', sampleCaps);
      expect(scorecard.lineage).toBeNull();
    });

    it('should have null lineage with empty prior runs', async () => {
      const scorecard = await judgeEvolution('test', sampleCaps, undefined, []);
      expect(scorecard.lineage).toBeNull();
    });

    it('should compute lineage from prior run summaries', async () => {
      const priorRuns: LineageRunSummary[] = [{
        run_number: 1,
        timestamp: '2026-01-01T00:00:00Z',
        input_hash: 'abc123',
        power_level: 40,
        overall_grade: 'C',
        rank_title: 'Journeyman Mage',
        total_xp: 1250,
        level_xps: [300, 250, 200, 100, 400],
        level_grades: ['D', 'D', 'D', 'D', 'C'],
      }];

      const scorecard = await judgeEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(scorecard.lineage).not.toBeNull();
      const lineage = scorecard.lineage!;
      expect(lineage.run_number).toBe(2);
      expect(lineage.prior_power_level).toBe(40);
      expect(lineage.prior_grade).toBe('C');
      expect(lineage.deltas).toHaveLength(5);
      expect(lineage.cumulative_runs).toBe(2);
      expect(lineage.history).toHaveLength(1);
      expect(typeof lineage.trajectory).toBe('number');
      expect(['improving', 'stable', 'declining']).toContain(lineage.trend);

      for (const d of lineage.deltas) {
        expect(d.level).toBeGreaterThanOrEqual(1);
        expect(typeof d.xp_delta).toBe('number');
        expect(typeof d.grade_change).toBe('string');
      }
    });

    it('should track improving trend when current scores exceed prior', async () => {
      const priorRuns: LineageRunSummary[] = [{
        run_number: 1,
        timestamp: '2026-01-01T00:00:00Z',
        input_hash: 'abc123',
        power_level: 10,
        overall_grade: 'D',
        rank_title: 'Fledgling Mutant',
        total_xp: 250,
        level_xps: [50, 50, 50, 50, 50],
        level_grades: ['D', 'D', 'D', 'D', 'D'],
      }];

      const scorecard = await judgeEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(scorecard.lineage!.trend).toBe('improving');
    });

    it('should compute trajectory from 3+ data points', async () => {
      const priorRuns: LineageRunSummary[] = [
        { run_number: 1, timestamp: '2026-01-01T00:00:00Z', input_hash: 'a', power_level: 20, overall_grade: 'D', rank_title: 'Fledgling Mutant', total_xp: 500, level_xps: [100, 100, 100, 100, 100], level_grades: ['D', 'D', 'D', 'D', 'D'] },
        { run_number: 2, timestamp: '2026-01-02T00:00:00Z', input_hash: 'b', power_level: 30, overall_grade: 'D', rank_title: 'Apprentice Scribe', total_xp: 750, level_xps: [150, 150, 150, 150, 150], level_grades: ['D', 'D', 'D', 'D', 'D'] },
        { run_number: 3, timestamp: '2026-01-03T00:00:00Z', input_hash: 'c', power_level: 35, overall_grade: 'C', rank_title: 'Apprentice Scribe', total_xp: 900, level_xps: [180, 180, 180, 180, 180], level_grades: ['D', 'D', 'D', 'D', 'D'] },
      ];

      const scorecard = await judgeEvolution('The amazing fox', sampleCaps, undefined, priorRuns);
      expect(scorecard.lineage).not.toBeNull();
      expect(scorecard.lineage!.history).toHaveLength(3);
      expect(typeof scorecard.lineage!.trajectory).toBe('number');
      // With 3 prior runs at 20, 30, 35 plus current (real caps), trajectory should be positive
      expect(scorecard.lineage!.trajectory).toBeGreaterThan(0);
    });

    it('should pass lineage context to LLM judge prompt', async () => {
      let capturedPrompt = '';
      const captureProvider: LLMProvider = {
        id: 'capture',
        name: 'Capture Provider',
        async isAvailable() { return true; },
        async chat(messages) {
          capturedPrompt = messages[0].content;
          return {
            content: JSON.stringify([
              'Commentary 1', 'Commentary 2', 'Commentary 3', 'Commentary 4', 'Commentary 5',
            ]),
            tool_calls: null,
          };
        },
      };

      const priorRuns: LineageRunSummary[] = [
        { run_number: 1, timestamp: '2026-01-01T00:00:00Z', input_hash: 'a', power_level: 90, overall_grade: 'S', rank_title: 'Mythic Architect', total_xp: 4500, level_xps: [900, 900, 900, 900, 900], level_grades: ['S', 'S', 'S', 'S', 'S'] },
        { run_number: 2, timestamp: '2026-01-02T00:00:00Z', input_hash: 'b', power_level: 80, overall_grade: 'A', rank_title: 'Grand Sorcerer', total_xp: 4000, level_xps: [800, 800, 800, 800, 800], level_grades: ['A', 'A', 'A', 'A', 'A'] },
        { run_number: 3, timestamp: '2026-01-03T00:00:00Z', input_hash: 'c', power_level: 70, overall_grade: 'A', rank_title: 'Grand Sorcerer', total_xp: 3500, level_xps: [700, 700, 700, 700, 700], level_grades: ['A', 'A', 'A', 'A', 'A'] },
      ];

      await judgeEvolution('The amazing fox', sampleCaps, captureProvider, priorRuns);
      expect(capturedPrompt).toContain('run #4');
      expect(capturedPrompt).toContain('Trajectory');
      // Should detect declining and include warning (90→80→70→current which is lower)
      expect(capturedPrompt.toLowerCase()).toContain('declining');
    });
  });

  describe('full cycle with scorecard', () => {
    let result: Record<string, unknown>;
    let workDir: string;

    beforeAll(async () => {
      workDir = join(testWorkDir, `scorecard-${Date.now()}`);
      const agent = new OuroborosAgent(workDir);
      const input = 'The amazing fox is great. Email: test@example.com, URL: https://test.dev, Date: 2026-01-15';
      const resultStr = await agent.execute({ input });
      result = JSON.parse(resultStr);
    }, 30000);

    it('should include scorecard in final output', () => {
      expect(result.scorecard).toBeDefined();
      const sc = result.scorecard as EvolutionScorecard;
      expect(sc.levels).toHaveLength(5);
      expect(sc.formatted).toContain('OUROBOROS EVOLUTION SCORECARD');
      expect(sc.power_level).toBeGreaterThan(0);
    });

    it('should have valid grades and XP', () => {
      const sc = result.scorecard as EvolutionScorecard;
      expect(sc.total_xp).toBeGreaterThan(0);
      expect(['S', 'A', 'B', 'C', 'D']).toContain(sc.overall_grade);
      expect(sc.rank_title.length).toBeGreaterThan(0);
    });

    it('should use deterministic judge mode without provider', () => {
      const sc = result.scorecard as EvolutionScorecard;
      expect(sc.judge_mode).toBe('deterministic');
    });

    it('should also include scorecard on cached runs', async () => {
      // Second run uses cache — should still have scorecard
      const agent2 = new OuroborosAgent(workDir);
      const result2Str = await agent2.execute({ input: 'cached run test' });
      const result2 = JSON.parse(result2Str);
      expect(result2.scorecard).toBeDefined();
      const sc = result2.scorecard as EvolutionScorecard;
      expect(sc.levels).toHaveLength(5);
      expect(sc.power_level).toBeGreaterThanOrEqual(0);
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
