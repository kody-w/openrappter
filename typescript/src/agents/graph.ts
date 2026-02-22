/**
 * AgentGraph — DAG (directed acyclic graph) executor for parallel agent pipelines.
 *
 * Extends the agent chain concept to support arbitrary dependency graphs.
 * Nodes whose dependencies are all satisfied execute concurrently — no idle
 * waiting when work can proceed in parallel.
 *
 * When a node has multiple dependencies, all their data_slush outputs are
 * merged into a combined upstream_slush keyed by node name:
 *
 *   upstream_slush = { nodeA: { ...slushA }, nodeB: { ...slushB } }
 *
 * Usage:
 *   const graph = new AgentGraph()
 *     .addNode({ name: 'fetch', agent: webAgent, kwargs: { url: '...' } })
 *     .addNode({ name: 'parse', agent: parseAgent, dependsOn: ['fetch'] })
 *     .addNode({ name: 'store', agent: memAgent, dependsOn: ['parse'] })
 *     .addNode({ name: 'notify', agent: msgAgent, dependsOn: ['parse'] });
 *
 *   const result = await graph.run();
 *   // 'parse' runs after 'fetch'; 'store' and 'notify' run in parallel after 'parse'
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentResult } from './types.js';

export interface GraphNode {
  /** Unique name for this node */
  name: string;
  /** The agent to execute */
  agent: BasicAgent;
  /** Static kwargs to pass */
  kwargs?: Record<string, unknown>;
  /** Names of nodes this node depends on (must complete first) */
  dependsOn?: string[];
}

export interface GraphNodeResult {
  name: string;
  agentName: string;
  result: AgentResult;
  dataSlush: Record<string, unknown> | null;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
}

export interface GraphResult {
  status: 'success' | 'partial' | 'error';
  nodes: Map<string, GraphNodeResult>;
  executionOrder: string[];
  totalDurationMs: number;
  error?: string;
}

export interface GraphOptions {
  /** Timeout per node in ms (default: no timeout) */
  nodeTimeout?: number;
  /** Stop the graph on first error (default: false — skip dependents) */
  stopOnError?: boolean;
}

export class AgentGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private options: GraphOptions;

  constructor(options: GraphOptions = {}) {
    this.options = {
      nodeTimeout: options.nodeTimeout,
      stopOnError: options.stopOnError ?? false,
    };
  }

  /**
   * Add a node to the graph. Returns `this` for fluent chaining.
   */
  addNode(node: GraphNode): this {
    if (this.nodes.has(node.name)) {
      throw new Error(`AgentGraph: duplicate node name "${node.name}"`);
    }
    this.nodes.set(node.name, node);
    return this;
  }

  /**
   * Get all node names.
   */
  getNodeNames(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get the number of nodes.
   */
  get length(): number {
    return this.nodes.size;
  }

  /**
   * Validate the graph: check for missing dependencies and cycles.
   * Returns a result object rather than throwing so callers can inspect errors.
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check that all referenced dependencies exist
    for (const [name, node] of this.nodes) {
      for (const dep of node.dependsOn ?? []) {
        if (!this.nodes.has(dep)) {
          errors.push(`Node "${name}" depends on "${dep}", which does not exist`);
        }
      }
    }

    // Detect cycles using DFS
    const WHITE = 0; // not visited
    const GRAY = 1;  // in progress (on the stack)
    const BLACK = 2; // done

    const color = new Map<string, number>();
    for (const name of this.nodes.keys()) {
      color.set(name, WHITE);
    }

    const dfs = (name: string, stack: string[]): boolean => {
      color.set(name, GRAY);
      stack.push(name);

      const node = this.nodes.get(name)!;
      for (const dep of node.dependsOn ?? []) {
        if (!this.nodes.has(dep)) continue; // already reported as missing
        if (color.get(dep) === GRAY) {
          const cycleStart = stack.indexOf(dep);
          const cycle = [...stack.slice(cycleStart), dep].join(' → ');
          errors.push(`Cycle detected: ${cycle}`);
          return true;
        }
        if (color.get(dep) === WHITE) {
          if (dfs(dep, stack)) return true;
        }
      }

      stack.pop();
      color.set(name, BLACK);
      return false;
    };

    for (const name of this.nodes.keys()) {
      if (color.get(name) === WHITE) {
        dfs(name, []);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Execute the DAG. Nodes at each topological level run concurrently.
   * data_slush from completed nodes is forwarded to dependents as upstream_slush.
   */
  async run(initialKwargs?: Record<string, unknown>): Promise<GraphResult> {
    const validation = this.validate();
    if (!validation.valid) {
      throw new Error(`AgentGraph validation failed:\n${validation.errors.join('\n')}`);
    }

    const graphStart = Date.now();
    const nodeResults = new Map<string, GraphNodeResult>();
    const executionOrder: string[] = [];
    const skipped = new Set<string>();

    // Compute topological levels using Kahn's algorithm
    const levels = this.topologicalLevels();

    for (const level of levels) {
      // Check if stopOnError was triggered in a previous level
      if (this.options.stopOnError && this.hasError(nodeResults)) {
        // Mark remaining nodes as skipped
        for (const name of level) {
          if (!nodeResults.has(name)) {
            nodeResults.set(name, this.makeSkipped(name));
            executionOrder.push(name);
          }
        }
        continue;
      }

      // Determine which nodes in this level should run vs. be skipped
      const toRun: string[] = [];
      for (const name of level) {
        if (this.shouldSkip(name, skipped, nodeResults)) {
          skipped.add(name);
          nodeResults.set(name, this.makeSkipped(name));
          executionOrder.push(name);
        } else {
          toRun.push(name);
        }
      }

      if (toRun.length === 0) continue;

      // Execute all runnable nodes in this level concurrently
      const levelPromises = toRun.map(name =>
        this.executeNode(name, nodeResults, initialKwargs).then(result => {
          nodeResults.set(name, result);
          executionOrder.push(name);
          if (result.status === 'error') {
            // Mark all transitive dependents as skipped when not stopping on error
            if (!this.options.stopOnError) {
              this.collectDependents(name, skipped);
            }
          }
        })
      );

      if (this.options.stopOnError) {
        // Run concurrently but check for errors before proceeding
        const results = await Promise.allSettled(levelPromises);
        const firstRejection = results.find(r => r.status === 'rejected');
        if (firstRejection) {
          // Unexpected non-agent error (e.g. timeout promise rejected)
          // Agent errors are caught inside executeNode and returned as GraphNodeResult
          const reason = (firstRejection as PromiseRejectedResult).reason as Error;
          return {
            status: 'error',
            nodes: nodeResults,
            executionOrder,
            totalDurationMs: Date.now() - graphStart,
            error: reason.message,
          };
        }

        if (this.hasError(nodeResults)) {
          // Mark all remaining unexecuted nodes as skipped
          const allNames = Array.from(this.nodes.keys());
          for (const name of allNames) {
            if (!nodeResults.has(name)) {
              nodeResults.set(name, this.makeSkipped(name));
              executionOrder.push(name);
            }
          }
          const failedNode = Array.from(nodeResults.values()).find(r => r.status === 'error');
          return {
            status: 'error',
            nodes: nodeResults,
            executionOrder,
            totalDurationMs: Date.now() - graphStart,
            error: failedNode?.result.message ?? 'A node failed',
          };
        }
      } else {
        await Promise.all(levelPromises);
      }
    }

    const hasErrors = Array.from(nodeResults.values()).some(r => r.status === 'error');
    const hasSkipped = Array.from(nodeResults.values()).some(r => r.status === 'skipped');

    return {
      status: hasErrors || hasSkipped ? 'partial' : 'success',
      nodes: nodeResults,
      executionOrder,
      totalDurationMs: Date.now() - graphStart,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute topological levels using Kahn's algorithm.
   * Each level is a set of nodes whose dependencies are all in earlier levels.
   * Nodes within a level can be executed concurrently.
   */
  private topologicalLevels(): string[][] {
    // Build in-degree and adjacency maps
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // dep → list of nodes that need dep

    for (const name of this.nodes.keys()) {
      inDegree.set(name, 0);
      dependents.set(name, []);
    }

    for (const [name, node] of this.nodes) {
      for (const dep of node.dependsOn ?? []) {
        if (this.nodes.has(dep)) {
          inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
          dependents.get(dep)!.push(name);
        }
      }
    }

    const levels: string[][] = [];
    let currentLevel = Array.from(inDegree.entries())
      .filter(([, deg]) => deg === 0)
      .map(([name]) => name);

    while (currentLevel.length > 0) {
      levels.push(currentLevel);
      const nextLevel: string[] = [];
      for (const name of currentLevel) {
        for (const dependent of dependents.get(name) ?? []) {
          const newDegree = (inDegree.get(dependent) ?? 0) - 1;
          inDegree.set(dependent, newDegree);
          if (newDegree === 0) {
            nextLevel.push(dependent);
          }
        }
      }
      currentLevel = nextLevel;
    }

    return levels;
  }

  /**
   * Execute a single node, building its kwargs from static config + upstream slush.
   */
  private async executeNode(
    name: string,
    completed: Map<string, GraphNodeResult>,
    initialKwargs?: Record<string, unknown>,
  ): Promise<GraphNodeResult> {
    const node = this.nodes.get(name)!;
    const nodeStart = Date.now();

    // Build kwargs: initial (for root nodes) + static node kwargs
    const isRoot = (node.dependsOn ?? []).length === 0;
    const kwargs: Record<string, unknown> = {
      ...(isRoot && initialKwargs ? initialKwargs : {}),
      ...(node.kwargs ?? {}),
    };

    // Merge upstream slush from all dependencies
    const deps = node.dependsOn ?? [];
    if (deps.length > 0) {
      const upstreamSlush: Record<string, unknown> = {};
      for (const dep of deps) {
        const depResult = completed.get(dep);
        if (depResult?.dataSlush) {
          upstreamSlush[dep] = depResult.dataSlush;
        }
      }
      if (Object.keys(upstreamSlush).length > 0) {
        kwargs.upstream_slush = upstreamSlush;
      }
    }

    try {
      const resultStr = await this.executeWithTimeout(node.agent, kwargs);
      const durationMs = Date.now() - nodeStart;

      let result: AgentResult;
      try {
        result = JSON.parse(resultStr) as AgentResult;
      } catch {
        result = { status: 'success', raw: resultStr } as unknown as AgentResult;
      }

      const dataSlush = node.agent.lastDataSlush ?? null;
      const effectiveSlush = dataSlush ?? node.agent.slushOut({
        signals: { node_name: name, node_result_status: result.status },
      });

      return {
        name,
        agentName: node.agent.name,
        result,
        dataSlush: effectiveSlush,
        durationMs,
        status: 'success',
      };
    } catch (e) {
      const durationMs = Date.now() - nodeStart;
      const error = e as Error;
      const errorResult: AgentResult = {
        status: 'error',
        message: error.message,
      };

      return {
        name,
        agentName: node.agent.name,
        result: errorResult,
        dataSlush: null,
        durationMs,
        status: 'error',
      };
    }
  }

  /**
   * Wrap an agent execution with an optional per-node timeout.
   */
  private async executeWithTimeout(
    agent: BasicAgent,
    kwargs: Record<string, unknown>,
  ): Promise<string> {
    const promise = agent.execute(kwargs);
    if (!this.options.nodeTimeout) return promise;

    return Promise.race([
      promise,
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Node timeout after ${this.options.nodeTimeout}ms`)),
          this.options.nodeTimeout,
        )
      ),
    ]);
  }

  /**
   * Determine whether a node should be skipped because at least one of its
   * dependencies either failed or was already skipped.
   */
  private shouldSkip(
    name: string,
    skipped: Set<string>,
    completed: Map<string, GraphNodeResult>,
  ): boolean {
    const node = this.nodes.get(name)!;
    for (const dep of node.dependsOn ?? []) {
      if (skipped.has(dep)) return true;
      const depResult = completed.get(dep);
      if (depResult && depResult.status === 'error') return true;
    }
    return false;
  }

  /**
   * Recursively collect all transitive dependents of a failed node
   * so they can be pre-marked as skipped.
   */
  private collectDependents(failedName: string, skipped: Set<string>): void {
    for (const [name, node] of this.nodes) {
      if (!skipped.has(name) && (node.dependsOn ?? []).includes(failedName)) {
        skipped.add(name);
        this.collectDependents(name, skipped);
      }
    }
  }

  /**
   * Check whether any completed node has an error status.
   */
  private hasError(nodeResults: Map<string, GraphNodeResult>): boolean {
    for (const result of nodeResults.values()) {
      if (result.status === 'error') return true;
    }
    return false;
  }

  /**
   * Build a skipped GraphNodeResult for a node that was not executed.
   */
  private makeSkipped(name: string): GraphNodeResult {
    const node = this.nodes.get(name)!;
    return {
      name,
      agentName: node.agent.name,
      result: { status: 'info', message: 'skipped' },
      dataSlush: null,
      durationMs: 0,
      status: 'skipped',
    };
  }
}

export function createAgentGraph(options?: GraphOptions): AgentGraph {
  return new AgentGraph(options);
}
