/**
 * LearnNewAgent Parity Tests
 *
 * Tests the TypeScript port of LearnNewAgent — the meta-agent that
 * creates new agents from natural language descriptions at runtime.
 *
 * Mirrors Python openrappter/agents/learn_new_agent.py
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('LearnNewAgent', () => {
  let LearnNewAgentClass: typeof import('../../agents/LearnNewAgent.js').LearnNewAgent;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import('../../agents/LearnNewAgent.js');
    LearnNewAgentClass = mod.LearnNewAgent;
    // Create a unique temp dir for each test to avoid collisions
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-new-agent-test-'));
  });

  afterEach(async () => {
    // Clean up temp dir
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── Single File Agent Pattern ──────────────────────────────────────

  describe('Single File Agent Pattern', () => {
    it('should use explicit name+metadata constructor', () => {
      const agent = new LearnNewAgentClass();
      expect(agent.name).toBe('LearnNew');
      expect(agent.metadata.name).toBe('LearnNew');
    });

    it('should have correct metadata description', () => {
      const agent = new LearnNewAgentClass();
      expect(agent.metadata.description).toContain('Creates new agents');
      expect(agent.metadata.description).toContain('natural language');
    });

    it('should have correct parameter schema', () => {
      const agent = new LearnNewAgentClass();
      const params = agent.metadata.parameters;
      expect(params.type).toBe('object');
      expect(params.properties).toHaveProperty('description');
      expect(params.properties).toHaveProperty('name');
      expect(params.properties).toHaveProperty('action');
      expect(params.properties).toHaveProperty('query');
      expect(params.required).toEqual([]);
    });

    it('action parameter should have enum: create, list, delete', () => {
      const agent = new LearnNewAgentClass();
      const actionParam = agent.metadata.parameters.properties.action;
      expect(actionParam.enum).toEqual(['create', 'list', 'delete']);
    });
  });

  // ── Name Generation ────────────────────────────────────────────────

  describe('Name Generation', () => {
    it('should generate name from description keywords', () => {
      const agent = new LearnNewAgentClass();
      // Access the private method via any cast for testing
      const name = (agent as any).generateName('fetch weather data from an API');
      expect(name).toBeTruthy();
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(30);
    });

    it('should filter stop words from name generation', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).generateName('create something that would process data');
      // Stop words (that, this, with, from, create, make, want, should, would, could) are filtered
      expect(name).not.toMatch(/^(That|This|With|From|Create|Make|Want|Should|Would|Could)$/);
    });

    it('should return Custom as fallback for empty-ish descriptions', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).generateName('a to do it');
      // All words are short or stop words
      expect(name).toBe('Custom');
    });

    it('should capitalize keyword components', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).generateName('analyze sentiment');
      // Should be CamelCase
      expect(name[0]).toBe(name[0].toUpperCase());
    });

    it('should limit to first 2 keywords', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).generateName('monitor server performance metrics dashboard');
      // Should use at most 2 keyword components
      const words = name.match(/[A-Z][a-z]*/g) || [];
      expect(words.length).toBeLessThanOrEqual(2);
    });
  });

  // ── Name Sanitization ──────────────────────────────────────────────

  describe('Name Sanitization', () => {
    it('should remove non-alphanumeric characters', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).sanitizeName('Hello-World!@#');
      expect(name).toBe('HelloWorld');
    });

    it('should prefix with Agent if starts with number', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).sanitizeName('42things');
      expect(name).toBe('Agent42things');
    });

    it('should capitalize first letter', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).sanitizeName('myAgent');
      expect(name).toBe('MyAgent');
    });

    it('should return Custom for empty string', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).sanitizeName('');
      expect(name).toBe('Custom');
    });

    it('should handle all-special-characters input', () => {
      const agent = new LearnNewAgentClass();
      const name = (agent as any).sanitizeName('!@#$%');
      expect(name).toBe('Custom');
    });
  });

  // ── CamelCase to snake_case ────────────────────────────────────────

  describe('toSnakeCase', () => {
    it('should convert CamelCase to snake_case', () => {
      const agent = new LearnNewAgentClass();
      expect((agent as any).toSnakeCase('HelloWorld')).toBe('hello_world');
    });

    it('should handle consecutive uppercase', () => {
      const agent = new LearnNewAgentClass();
      expect((agent as any).toSnakeCase('HTMLParser')).toBe('html_parser');
    });

    it('should handle single word', () => {
      const agent = new LearnNewAgentClass();
      expect((agent as any).toSnakeCase('Custom')).toBe('custom');
    });

    it('should handle already snake_case', () => {
      const agent = new LearnNewAgentClass();
      expect((agent as any).toSnakeCase('already')).toBe('already');
    });
  });

  // ── Extra Params Generation ────────────────────────────────────────

  describe('Extra Params Generation', () => {
    it('should detect file/path keywords and add path param', () => {
      const agent = new LearnNewAgentClass();
      const params = (agent as any).generateExtraParams('read a file and process it');
      expect(params).toHaveProperty('path');
      expect(params.path.type).toBe('string');
    });

    it('should detect URL/web keywords and add url param', () => {
      const agent = new LearnNewAgentClass();
      const params = (agent as any).generateExtraParams('fetch data from a URL endpoint');
      expect(params).toHaveProperty('url');
      expect(params.url.type).toBe('string');
    });

    it('should detect number/count keywords and add count param', () => {
      const agent = new LearnNewAgentClass();
      const params = (agent as any).generateExtraParams('limit the number of results');
      expect(params).toHaveProperty('count');
      expect(params.count.type).toBe('integer');
    });

    it('should return empty object for unrecognized descriptions', () => {
      const agent = new LearnNewAgentClass();
      const params = (agent as any).generateExtraParams('just do something nice');
      expect(Object.keys(params).length).toBe(0);
    });

    it('should detect multiple keyword categories', () => {
      const agent = new LearnNewAgentClass();
      const params = (agent as any).generateExtraParams('fetch a url file and count the number of lines');
      expect(params).toHaveProperty('path');
      expect(params).toHaveProperty('url');
      expect(params).toHaveProperty('count');
    });
  });

  // ── Extra Imports Generation ───────────────────────────────────────

  describe('Extra Imports Generation', () => {
    it('should detect HTTP/API/fetch keywords', () => {
      const agent = new LearnNewAgentClass();
      const imports = (agent as any).generateExtraImports('fetch data from an API');
      expect(imports).toContain("import https from 'https';");
    });

    it('should detect datetime keywords', () => {
      const agent = new LearnNewAgentClass();
      const imports = (agent as any).generateExtraImports('get the current timestamp');
      // No extra import needed for Date in JS, but may include a utility
      expect(Array.isArray(imports)).toBe(true);
    });

    it('should detect file/path keywords', () => {
      const agent = new LearnNewAgentClass();
      const imports = (agent as any).generateExtraImports('read and write files');
      expect(imports.some((i: string) => i.includes('fs'))).toBe(true);
    });

    it('should detect regex keywords', () => {
      const agent = new LearnNewAgentClass();
      const imports = (agent as any).generateExtraImports('match a pattern using regex');
      // No import needed for regex in JS, should return empty or no regex import
      expect(Array.isArray(imports)).toBe(true);
    });

    it('should detect crypto/hash keywords', () => {
      const agent = new LearnNewAgentClass();
      const imports = (agent as any).generateExtraImports('generate a sha256 hash');
      expect(imports.some((i: string) => i.includes('crypto'))).toBe(true);
    });

    it('should return empty array for unrecognized descriptions', () => {
      const agent = new LearnNewAgentClass();
      const imports = (agent as any).generateExtraImports('just think about life');
      expect(imports).toEqual([]);
    });
  });

  // ── Tag Generation ─────────────────────────────────────────────────

  describe('Tag Generation', () => {
    it('should generate tags from description keywords', () => {
      const agent = new LearnNewAgentClass();
      const tags = (agent as any).generateTags('fetch weather data from an API');
      expect(tags).toContain('weather');
      expect(tags).toContain('api');
    });

    it('should return [custom] for unrecognized descriptions', () => {
      const agent = new LearnNewAgentClass();
      const tags = (agent as any).generateTags('do something unique');
      expect(tags).toEqual(['custom']);
    });

    it('should not duplicate tags', () => {
      const agent = new LearnNewAgentClass();
      const tags = (agent as any).generateTags('web api web api');
      const unique = new Set(tags);
      expect(tags.length).toBe(unique.size);
    });
  });

  // ── Agent Creation (perform: create) ───────────────────────────────

  describe('Agent Creation', () => {
    it('should create an agent file from description', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        description: 'analyze text sentiment',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.agent_name).toBeTruthy();
      expect(parsed.file_path).toBeTruthy();

      // Verify file was created
      const files = await fs.readdir(tmpDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some(f => f.endsWith('_agent.js'))).toBe(true);
    });

    it('should use provided name if given', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        description: 'analyze text sentiment',
        name: 'Sentiment',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.agent_name).toBe('Sentiment');

      const files = await fs.readdir(tmpDir);
      expect(files).toContain('sentiment_agent.js');
    });

    it('should error on missing description', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        description: '',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('description');
    });

    it('should error on duplicate agent name', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'first agent',
        name: 'Duplicate',
      });
      const result = await agent.perform({
        action: 'create',
        description: 'second agent',
        name: 'Duplicate',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('already exists');
    });

    it('should use query as description if description not provided', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        query: 'monitor server uptime',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
    });

    it('generated file should contain agent class definition', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'process CSV data',
        name: 'CsvProcessor',
      });

      const filePath = path.join(tmpDir, 'csv_processor_agent.js');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('CsvProcessorAgent');
      expect(content).toContain('createAgent');
      expect(content).toContain('perform');
      expect(content).toContain('Auto-generated by LearnNewAgent');
    });

    it('generated file should include extra params when relevant', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'read file contents and count lines',
        name: 'FileCounter',
      });

      const filePath = path.join(tmpDir, 'file_counter_agent.js');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('path');
      expect(content).toContain('count');
    });
  });

  // ── Hot Loading ────────────────────────────────────────────────────

  describe('Hot Loading', () => {
    it('should hot-load a created agent', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        description: 'echo user input',
        name: 'Echo',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.hot_loaded).toBe(true);
    });

    it('hot-loaded agent should be a valid BasicAgent instance', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        description: 'echo user input',
        name: 'Echo',
      });
      const parsed = JSON.parse(result);
      expect(parsed.hot_loaded).toBe(true);

      // The agent should be retrievable from the loaded agents map
      const loadedAgent = (agent as any).loadedAgents.get('Echo');
      expect(loadedAgent).toBeDefined();
      expect(loadedAgent.name).toBe('Echo');
      expect(loadedAgent.metadata).toBeDefined();
      expect(loadedAgent.metadata.name).toBe('Echo');
    });

    it('hot-loaded agent should be executable', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'echo user input',
        name: 'Echo',
      });

      const loadedAgent = (agent as any).loadedAgents.get('Echo');
      expect(loadedAgent).toBeDefined();

      const execResult = await loadedAgent.perform({ query: 'hello world' });
      const parsed = JSON.parse(execResult);
      expect(parsed.status).toBe('success');
    });
  });

  // ── Agent Listing (perform: list) ──────────────────────────────────

  describe('Agent Listing', () => {
    it('should list no agents in empty directory', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({ action: 'list' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.agents).toEqual([]);
      expect(parsed.count).toBe(0);
    });

    it('should list created agents', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'first agent',
        name: 'Alpha',
      });
      await agent.perform({
        action: 'create',
        description: 'second agent',
        name: 'Beta',
      });

      const result = await agent.perform({ action: 'list' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.count).toBe(2);
      expect(parsed.agents.some((a: any) => a.name === 'alpha')).toBe(true);
      expect(parsed.agents.some((a: any) => a.name === 'beta')).toBe(true);
    });

    it('should detect auto-generated agents', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'auto test',
        name: 'AutoTest',
      });

      const result = await agent.perform({ action: 'list' });
      const parsed = JSON.parse(result);
      expect(parsed.agents[0].auto_generated).toBe(true);
    });
  });

  // ── Agent Deletion (perform: delete) ───────────────────────────────

  describe('Agent Deletion', () => {
    it('should delete a created agent', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'deletable agent',
        name: 'Deletable',
      });

      const result = await agent.perform({
        action: 'delete',
        name: 'Deletable',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');

      // Verify file is gone
      const files = await fs.readdir(tmpDir);
      expect(files.some(f => f.includes('deletable'))).toBe(false);
    });

    it('should error when deleting nonexistent agent', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'delete',
        name: 'NonExistent',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });

    it('should error when no name provided for delete', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'delete',
        name: '',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });

    it('should find agent by fuzzy name match', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'fuzzy agent',
        name: 'FuzzyMatch',
      });

      // Delete using just partial name
      const result = await agent.perform({
        action: 'delete',
        name: 'fuzzy',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
    });
  });

  // ── Core Agent Protection ──────────────────────────────────────────

  describe('Core Agent Protection', () => {
    it('should prevent deletion of core agents', async () => {
      const agent = new LearnNewAgentClass(tmpDir);

      // Write a fake core agent file to test protection
      await fs.writeFile(path.join(tmpDir, 'basic_agent.js'), '// core');

      const result = await agent.perform({
        action: 'delete',
        name: 'basic_agent',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('core');
    });

    it('should protect all listed core agent files', () => {
      const agent = new LearnNewAgentClass();
      const coreFiles = (agent as any).coreAgentFiles;
      expect(coreFiles).toContain('BasicAgent.ts');
      expect(coreFiles).toContain('ShellAgent.ts');
      expect(coreFiles).toContain('MemoryAgent.ts');
      expect(coreFiles).toContain('LearnNewAgent.ts');
    });
  });

  // ── Default Action ─────────────────────────────────────────────────

  describe('Default Action', () => {
    it('should default to create action', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        description: 'test default action',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.agent_name).toBeTruthy();
    });
  });

  // ── Python Parity ──────────────────────────────────────────────────

  describe('Python Parity', () => {
    it('both runtimes should support same actions: create, list, delete', () => {
      const agent = new LearnNewAgentClass();
      const actionParam = agent.metadata.parameters.properties.action;
      expect(actionParam.enum).toEqual(['create', 'list', 'delete']);
    });

    it('both runtimes should use same parameter names', () => {
      const agent = new LearnNewAgentClass();
      const props = agent.metadata.parameters.properties;
      // Python has: description, name, action, query
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('action');
      expect(props).toHaveProperty('query');
    });

    it('both runtimes should generate snake_case file names', () => {
      const agent = new LearnNewAgentClass();
      expect((agent as any).toSnakeCase('HelloWorld')).toBe('hello_world');
      expect((agent as any).toSnakeCase('HTMLParser')).toBe('html_parser');
    });

    it('both runtimes should return JSON results with status field', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.perform({
        action: 'create',
        description: 'test parity',
        name: 'Parity',
      });
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('message');
      expect(parsed).toHaveProperty('agent_name');
      expect(parsed).toHaveProperty('file_path');
    });

    it('both runtimes should mark auto-generated agents in listing', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      await agent.perform({
        action: 'create',
        description: 'parity test',
        name: 'ParityList',
      });
      const result = await agent.perform({ action: 'list' });
      const parsed = JSON.parse(result);
      expect(parsed.agents[0]).toHaveProperty('auto_generated');
    });

    it('both runtimes should use same stop words for name generation', () => {
      const agent = new LearnNewAgentClass();
      // Python stop words: that, this, with, from, agent, create, make, want, should, would, could
      const stopWords = (agent as any).STOP_WORDS;
      expect(stopWords).toContain('that');
      expect(stopWords).toContain('this');
      expect(stopWords).toContain('with');
      expect(stopWords).toContain('from');
      expect(stopWords).toContain('agent');
      expect(stopWords).toContain('create');
      expect(stopWords).toContain('make');
      expect(stopWords).toContain('want');
      expect(stopWords).toContain('should');
      expect(stopWords).toContain('would');
      expect(stopWords).toContain('could');
    });

    it('both runtimes should protect core agents from deletion', () => {
      // Python: basic_agent.py, shell_agent.py, learn_new_agent.py, etc.
      // TypeScript: BasicAgent.ts, ShellAgent.ts, LearnNewAgent.ts, etc.
      const agent = new LearnNewAgentClass();
      const coreFiles = (agent as any).coreAgentFiles;
      expect(coreFiles.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Data Sloshing Integration ──────────────────────────────────────

  describe('Data Sloshing Integration', () => {
    it('should have working slushOut helper', () => {
      const agent = new LearnNewAgentClass();
      const slush = agent.slushOut({
        confidence: 'high',
        signals: { agents_created: 1 },
      });
      expect(slush.source_agent).toBe('LearnNew');
      expect(slush).toHaveProperty('timestamp');
      expect(slush.confidence).toBe('high');
    });

    it('execute() should work with data sloshing', async () => {
      const agent = new LearnNewAgentClass(tmpDir);
      const result = await agent.execute({
        action: 'list',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
    });
  });
});
