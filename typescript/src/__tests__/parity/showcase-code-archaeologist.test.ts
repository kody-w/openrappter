/**
 * Showcase: Code Archaeologist — AgentGraph fan-out/fan-in
 *
 * Three analysis agents run in parallel (fan-out), then a synthesis
 * agent merges all their findings (fan-in) via multi-upstream slush.
 */

import { describe, it, expect } from 'vitest';
import { AgentGraph } from '../../agents/graph.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Inline analysis agents ──

class GitHistoryAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'GitHistory',
      description: 'Analyzes git commit history',
      parameters: { type: 'object', properties: { repo: { type: 'string', description: 'Repository path' } }, required: [] },
    };
    super('GitHistory', metadata);
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      commits: 142,
      authors: ['alice', 'bob', 'charlie'],
      hotspots: ['src/auth.ts', 'src/api/routes.ts'],
      data_slush: {
        source_agent: 'GitHistory',
        analysis_type: 'git_history',
        commit_count: 142,
        top_authors: ['alice', 'bob'],
        hotspot_files: ['src/auth.ts', 'src/api/routes.ts'],
      },
    });
  }
}

class DependencyAnalyzerAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'DependencyAnalyzer',
      description: 'Analyzes project dependencies',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('DependencyAnalyzer', metadata);
  }

  async perform(): Promise<string> {
    return JSON.stringify({
      status: 'success',
      totalDeps: 24,
      outdated: 3,
      vulnerable: 1,
      data_slush: {
        source_agent: 'DependencyAnalyzer',
        analysis_type: 'dependencies',
        total: 24,
        outdated: ['lodash@3.x', 'moment@2.x', 'express@4.x'],
        vulnerable: ['lodash@3.x'],
      },
    });
  }
}

class ComplexityScorerAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'ComplexityScorer',
      description: 'Measures code complexity metrics',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('ComplexityScorer', metadata);
  }

  async perform(): Promise<string> {
    return JSON.stringify({
      status: 'success',
      averageCyclomaticComplexity: 4.2,
      maxComplexity: 18,
      highComplexityFiles: ['src/auth.ts', 'src/parser.ts'],
      data_slush: {
        source_agent: 'ComplexityScorer',
        analysis_type: 'complexity',
        avg_complexity: 4.2,
        max_complexity: 18,
        risky_files: ['src/auth.ts', 'src/parser.ts'],
      },
    });
  }
}

class SynthesisAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Synthesis',
      description: 'Merges findings from all analysis agents',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Synthesis', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>> | undefined;
    const sources = upstream ? Object.keys(upstream) : [];
    const analysisTypes = sources.map(s => (upstream![s] as Record<string, unknown>)?.analysis_type);

    // Cross-reference hotspots
    const gitHotspots = ((upstream?.git as Record<string, unknown>)?.hotspot_files ?? []) as string[];
    const complexRisky = ((upstream?.complexity as Record<string, unknown>)?.risky_files ?? []) as string[];
    const crossReferenced = gitHotspots.filter(f => complexRisky.includes(f));

    return JSON.stringify({
      status: 'success',
      synthesis: {
        sources_merged: sources.length,
        analysis_types: analysisTypes,
        cross_referenced_risks: crossReferenced,
        recommendation: crossReferenced.length > 0
          ? `Priority refactor: ${crossReferenced.join(', ')}`
          : 'No critical cross-references found',
      },
      data_slush: {
        source_agent: 'Synthesis',
        sources_merged: sources.length,
        cross_referenced: crossReferenced,
      },
    });
  }
}

describe('Showcase: Code Archaeologist', () => {
  describe('Fan-out / Fan-in pattern', () => {
    it('should run 3 analyzers in parallel then synthesize', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'git', agent: new GitHistoryAgent(), kwargs: { repo: '/test/repo' } })
        .addNode({ name: 'deps', agent: new DependencyAnalyzerAgent() })
        .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() })
        .addNode({ name: 'synthesis', agent: new SynthesisAgent(), dependsOn: ['git', 'deps', 'complexity'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(4);

      // All 3 analyzers must run before synthesis
      const order = result.executionOrder;
      expect(order.indexOf('synthesis')).toBe(3);
    });

    it('should merge all 3 upstream slush sources into synthesis', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'git', agent: new GitHistoryAgent() })
        .addNode({ name: 'deps', agent: new DependencyAnalyzerAgent() })
        .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() })
        .addNode({ name: 'synthesis', agent: new SynthesisAgent(), dependsOn: ['git', 'deps', 'complexity'] });

      const result = await graph.run();
      const synthesisResult = result.nodes.get('synthesis')?.result as Record<string, unknown>;
      const synthesis = synthesisResult?.synthesis as Record<string, unknown>;
      expect(synthesis?.sources_merged).toBe(3);
      expect(synthesis?.analysis_types).toContain('git_history');
      expect(synthesis?.analysis_types).toContain('dependencies');
      expect(synthesis?.analysis_types).toContain('complexity');
    });

    it('should cross-reference hotspots and complex files', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'git', agent: new GitHistoryAgent() })
        .addNode({ name: 'deps', agent: new DependencyAnalyzerAgent() })
        .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() })
        .addNode({ name: 'synthesis', agent: new SynthesisAgent(), dependsOn: ['git', 'deps', 'complexity'] });

      const result = await graph.run();
      const synthesisResult = result.nodes.get('synthesis')?.result as Record<string, unknown>;
      const synthesis = synthesisResult?.synthesis as Record<string, unknown>;
      // src/auth.ts appears in both git hotspots and complexity risky files
      expect(synthesis?.cross_referenced_risks).toContain('src/auth.ts');
      expect(synthesis?.recommendation).toContain('src/auth.ts');
    });
  });

  describe('Individual analyzer output', () => {
    it('should produce valid data_slush from each analyzer', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'git', agent: new GitHistoryAgent() })
        .addNode({ name: 'deps', agent: new DependencyAnalyzerAgent() })
        .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() });

      const result = await graph.run();

      const gitSlush = result.nodes.get('git')?.dataSlush;
      expect(gitSlush?.source_agent).toBe('GitHistory');
      expect(gitSlush?.analysis_type).toBe('git_history');

      const depsSlush = result.nodes.get('deps')?.dataSlush;
      expect(depsSlush?.source_agent).toBe('DependencyAnalyzer');

      const complexSlush = result.nodes.get('complexity')?.dataSlush;
      expect(complexSlush?.source_agent).toBe('ComplexityScorer');
    });
  });

  describe('Parallel execution performance', () => {
    it('should execute analyzers concurrently', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'git', agent: new GitHistoryAgent() })
        .addNode({ name: 'deps', agent: new DependencyAnalyzerAgent() })
        .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() })
        .addNode({ name: 'synthesis', agent: new SynthesisAgent(), dependsOn: ['git', 'deps', 'complexity'] });

      const result = await graph.run();
      // Synthesis is always last since it depends on all 3
      const synthesisIdx = result.executionOrder.indexOf('synthesis');
      expect(synthesisIdx).toBe(result.executionOrder.length - 1);
    });
  });

  describe('Partial failure', () => {
    it('should skip synthesis if an analyzer fails', async () => {
      class FailingAnalyzer extends BasicAgent {
        constructor() {
          super('FailingAnalyzer', {
            name: 'FailingAnalyzer', description: 'Fails',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(): Promise<string> { throw new Error('Analysis failed'); }
      }

      const graph = new AgentGraph()
        .addNode({ name: 'git', agent: new GitHistoryAgent() })
        .addNode({ name: 'deps', agent: new FailingAnalyzer() })
        .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() })
        .addNode({ name: 'synthesis', agent: new SynthesisAgent(), dependsOn: ['git', 'deps', 'complexity'] });

      const result = await graph.run();
      expect(result.status).toBe('partial');
      expect(result.nodes.get('deps')?.status).toBe('error');
      expect(result.nodes.get('synthesis')?.status).toBe('skipped');
    });
  });
});
