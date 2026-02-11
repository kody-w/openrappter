/**
 * CLI Integration Tests
 * Tests the CLI structure and agent registry integration:
 * - AgentRegistry discovery and listing
 * - Agent execution through the registry
 * - CLI version and help structure
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { AgentRegistry } from '../../agents/AgentRegistry.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import { ShellAgent } from '../../agents/ShellAgent.js';
import { MemoryAgent } from '../../agents/MemoryAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('CLI Integration', () => {
  // ── AgentRegistry ─────────────────────────────────────────────────────
  // Note: AgentRegistry.discoverAgents() scans for *Agent.js files (compiled).
  // In test env (vitest), .ts sources are used directly, so discovery won't find
  // compiled agents. We test the registry API with direct imports instead.

  describe('AgentRegistry', () => {
    it('should handle empty/missing agents directory gracefully', async () => {
      const registry = new AgentRegistry('/nonexistent/path');
      await registry.discoverAgents();

      const agents = await registry.listAgents();
      expect(agents).toEqual([]);
    });

    it('should return undefined for non-existent agent', async () => {
      const registry = new AgentRegistry('/nonexistent/path');
      const agent = await registry.getAgent('NonExistentAgent');
      expect(agent).toBeUndefined();
    });

    it('should return empty Map when no agents discovered', async () => {
      const registry = new AgentRegistry('/nonexistent/path');
      const all = await registry.getAllAgents();
      expect(all).toBeInstanceOf(Map);
      expect(all.size).toBe(0);
    });
  });

  // ── Direct Agent Imports ──────────────────────────────────────────────

  describe('Agent direct imports', () => {
    it('should instantiate ShellAgent', () => {
      const agent = new ShellAgent();
      expect(agent).toBeInstanceOf(BasicAgent);
      expect(agent.name).toBe('Shell');
      expect(agent.metadata.description).toBeDefined();
    });

    it('should instantiate MemoryAgent', () => {
      const agent = new MemoryAgent();
      expect(agent).toBeInstanceOf(BasicAgent);
      expect(agent.name).toBe('Memory');
      expect(agent.metadata.description).toBeDefined();
    });

    it('should execute ShellAgent', async () => {
      const agent = new ShellAgent();
      const result = await agent.execute({ query: 'list directory' });
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result);
      expect(parsed.status).toBeDefined();
    });

    it('should execute MemoryAgent', async () => {
      const agent = new MemoryAgent();
      const result = await agent.execute({ query: 'remember that vitest is the test framework' });
      expect(typeof result).toBe('string');
    });

    it('should have agent metadata in correct format', () => {
      const shell = new ShellAgent();
      expect(shell.metadata.name).toBe('Shell');
      expect(shell.metadata.parameters.type).toBe('object');
      expect(shell.metadata.parameters.properties).toBeDefined();
    });
  });

  // ── CLI Entry Point ───────────────────────────────────────────────────

  describe('CLI entry point', () => {
    it('should have bin/openrappter.mjs', () => {
      const binPath = join(__dirname, '..', '..', '..', 'bin', 'openrappter.mjs');
      expect(existsSync(binPath)).toBe(true);
    });

    it('should have src/index.ts as source entry', () => {
      const srcPath = join(__dirname, '..', '..', 'index.ts');
      expect(existsSync(srcPath)).toBe(true);
    });
  });

  // ── Package Metadata ──────────────────────────────────────────────────

  describe('Package metadata', () => {
    it('should have package.json with correct name', async () => {
      const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
      expect(existsSync(pkgPath)).toBe(true);

      const pkg = await import(pkgPath, { with: { type: 'json' } });
      expect(pkg.default.name).toBe('openrappter');
    });

    it('should have a version', async () => {
      const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
      const pkg = await import(pkgPath, { with: { type: 'json' } });
      expect(pkg.default.version).toBeDefined();
      expect(typeof pkg.default.version).toBe('string');
    });

    it('should have vitest as dev dependency', async () => {
      const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
      const pkg = await import(pkgPath, { with: { type: 'json' } });
      expect(pkg.default.devDependencies?.vitest).toBeDefined();
    });
  });
});
