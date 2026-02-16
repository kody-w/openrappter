/**
 * OuroborosAgent Parity Tests
 * Tests for the self-evolving agent — evolution catalog, source transforms,
 * full generation cycle, safety, and data sloshing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OuroborosAgent, EVOLUTION_CATALOG } from '../../agents/OuroborosAgent.js';
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

    it('should default workDir to tmpdir when not provided', () => {
      const agent = new OuroborosAgent();
      expect(agent.workDir).toContain('ouroboros-');
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

    it('should rename class from OuroborosAgent to OuroborosGen1Agent', () => {
      const source = getAgentSource();
      const gen1 = EVOLUTION_CATALOG[0].apply(source, 1);
      expect(gen1).toContain('class OuroborosGen1Agent');
      expect(gen1).not.toContain('class OuroborosAgent');
    });

    it('should insert wordStats method for Gen 1', () => {
      const source = getAgentSource();
      const gen1 = EVOLUTION_CATALOG[0].apply(source, 1);
      expect(gen1).toContain('wordStats(text: string)');
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
      expect(source).toContain('wordStats(text: string)');
      expect(source).toContain('caesarEncrypt(text: string');
      expect(source).toContain('caesarDecrypt(text: string');
      expect(source).toContain('detectPatterns(text: string)');
      expect(source).toContain('analyzeSentiment(text: string)');
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
        const genPath = join(workDir, `OuroborosGen${g}Agent.ts`);
        expect(existsSync(genPath)).toBe(true);
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
  });
});
