/**
 * Showcase: The Architect — LearnNewAgent + AgentGraph DAG
 *
 * Demonstrates creating agents at runtime and wiring them into a DAG.
 * Validates: parallel graph execution, multi-upstream slush merging,
 * error propagation through DAG.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentGraph } from '../../agents/graph.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Inline agents (simulating what LearnNewAgent would create) ──

class DataValidatorAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'DataValidator',
      description: 'Validates incoming data records',
      parameters: { type: 'object', properties: { records: { type: 'array', description: 'Data records' } }, required: [] },
    };
    super('DataValidator', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const records = (kwargs.records ?? []) as unknown[];
    return JSON.stringify({
      status: 'success',
      validCount: records.length,
      invalidCount: 0,
      data_slush: {
        source_agent: 'DataValidator',
        validated: true,
        record_count: records.length,
        schema_version: '1.0',
      },
    });
  }
}

class TransformerAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Transformer',
      description: 'Transforms validated data',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Transformer', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown> | undefined;
    return JSON.stringify({
      status: 'success',
      transformed: true,
      received_upstream: !!upstream,
      data_slush: {
        source_agent: 'Transformer',
        format: 'normalized',
        transformations_applied: ['lowercase', 'trim', 'dedupe'],
      },
    });
  }
}

class ReporterAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Reporter',
      description: 'Generates final report from validated + transformed data',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Reporter', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown> | undefined;
    const upstreamKeys = upstream ? Object.keys(upstream) : [];
    return JSON.stringify({
      status: 'success',
      report: 'Data pipeline complete',
      upstream_sources: upstreamKeys,
      data_slush: {
        source_agent: 'Reporter',
        report_generated: true,
        summary: { sources: upstreamKeys.length },
      },
    });
  }
}

describe('Showcase: The Architect', () => {
  describe('DAG Wiring', () => {
    it('should wire 3 agents into a linear DAG', () => {
      const graph = new AgentGraph()
        .addNode({ name: 'validate', agent: new DataValidatorAgent() })
        .addNode({ name: 'transform', agent: new TransformerAgent(), dependsOn: ['validate'] })
        .addNode({ name: 'report', agent: new ReporterAgent(), dependsOn: ['validate', 'transform'] });

      expect(graph.length).toBe(3);
      const validation = graph.validate();
      expect(validation.valid).toBe(true);
    });

    it('should execute DAG in correct order', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'validate', agent: new DataValidatorAgent(), kwargs: { records: [1, 2, 3] } })
        .addNode({ name: 'transform', agent: new TransformerAgent(), dependsOn: ['validate'] })
        .addNode({ name: 'report', agent: new ReporterAgent(), dependsOn: ['validate', 'transform'] });

      const result = await graph.run();
      expect(result.status).toBe('success');

      // Validate comes before transform comes before report
      const order = result.executionOrder;
      expect(order.indexOf('validate')).toBeLessThan(order.indexOf('transform'));
      expect(order.indexOf('transform')).toBeLessThan(order.indexOf('report'));
    });

    it('should propagate data_slush through the DAG', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'validate', agent: new DataValidatorAgent(), kwargs: { records: [1, 2, 3] } })
        .addNode({ name: 'transform', agent: new TransformerAgent(), dependsOn: ['validate'] })
        .addNode({ name: 'report', agent: new ReporterAgent(), dependsOn: ['validate', 'transform'] });

      const result = await graph.run();

      // Validate node should have data_slush
      const validateResult = result.nodes.get('validate');
      expect(validateResult?.dataSlush).toBeTruthy();

      // Reporter gets merged upstream_slush from both validate and transform
      const reportResult = result.nodes.get('report');
      expect(reportResult?.status).toBe('success');
      const reportParsed = reportResult?.result;
      expect(reportParsed?.upstream_sources).toContain('validate');
      expect(reportParsed?.upstream_sources).toContain('transform');
    });
  });

  describe('Multi-upstream slush merging', () => {
    it('should merge slush from all upstream nodes', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'validate', agent: new DataValidatorAgent(), kwargs: { records: ['a', 'b'] } })
        .addNode({ name: 'transform', agent: new TransformerAgent(), dependsOn: ['validate'] })
        .addNode({ name: 'report', agent: new ReporterAgent(), dependsOn: ['validate', 'transform'] });

      const result = await graph.run();
      const reportResult = result.nodes.get('report')?.result as Record<string, unknown>;
      const sources = reportResult?.upstream_sources as string[];
      expect(sources).toEqual(expect.arrayContaining(['validate', 'transform']));
      expect(sources?.length).toBe(2);
    });
  });

  describe('Error propagation', () => {
    it('should skip downstream nodes when upstream fails', async () => {
      class FailingValidator extends BasicAgent {
        constructor() {
          super('FailingValidator', {
            name: 'FailingValidator',
            description: 'Always fails',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(): Promise<string> {
          throw new Error('Validation failed: corrupt data');
        }
      }

      const graph = new AgentGraph()
        .addNode({ name: 'validate', agent: new FailingValidator() })
        .addNode({ name: 'transform', agent: new TransformerAgent(), dependsOn: ['validate'] })
        .addNode({ name: 'report', agent: new ReporterAgent(), dependsOn: ['transform'] });

      const result = await graph.run();
      expect(result.status).toBe('partial');
      expect(result.nodes.get('validate')?.status).toBe('error');
      expect(result.nodes.get('transform')?.status).toBe('skipped');
      expect(result.nodes.get('report')?.status).toBe('skipped');
    });

    it('should stop immediately with stopOnError', async () => {
      class FailingValidator extends BasicAgent {
        constructor() {
          super('FailingValidator', {
            name: 'FailingValidator',
            description: 'Always fails',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(): Promise<string> {
          throw new Error('Validation failed');
        }
      }

      const graph = new AgentGraph({ stopOnError: true })
        .addNode({ name: 'validate', agent: new FailingValidator() })
        .addNode({ name: 'transform', agent: new TransformerAgent(), dependsOn: ['validate'] });

      const result = await graph.run();
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
    });
  });

  describe('Runtime agent creation simulation', () => {
    it('should dynamically create agents and wire into graph', async () => {
      // Simulates what LearnNewAgent would do: create agents from descriptions
      const agentDefinitions = [
        { name: 'DataValidator', cls: DataValidatorAgent },
        { name: 'Transformer', cls: TransformerAgent },
        { name: 'Reporter', cls: ReporterAgent },
      ];

      const agents = agentDefinitions.map(def => new def.cls());
      expect(agents.length).toBe(3);
      expect(agents.map(a => a.name)).toEqual(['DataValidator', 'Transformer', 'Reporter']);

      const graph = new AgentGraph()
        .addNode({ name: 'validate', agent: agents[0], kwargs: { records: ['x', 'y'] } })
        .addNode({ name: 'transform', agent: agents[1], dependsOn: ['validate'] })
        .addNode({ name: 'report', agent: agents[2], dependsOn: ['validate', 'transform'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(3);
    });
  });
});
