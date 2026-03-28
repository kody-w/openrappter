# AgentGraph

DAG (Directed Acyclic Graph) executor. Nodes whose dependencies are satisfied run concurrently; data flows automatically between nodes.

## Usage

```typescript
import { AgentGraph } from './agents/graph.js';

const graph = new AgentGraph()
  .addNode({ name: 'fetch', agent: webAgent, kwargs: { url: '...' } })
  .addNode({ name: 'parse', agent: parseAgent, dependsOn: ['fetch'] })
  .addNode({ name: 'store', agent: memAgent, dependsOn: ['parse'] })
  .addNode({ name: 'notify', agent: msgAgent, dependsOn: ['parse'] });

const result = await graph.run();
// 'parse' runs after 'fetch'
// 'store' and 'notify' run in parallel after 'parse'
```

## Execution Model

1. `validate()` — Check for missing dependencies and cycles (DFS three-color)
2. Compute topological levels via Kahn's algorithm
3. Each level's nodes execute concurrently via `Promise.all`
4. Failed node dependents are `skipped` (or stop immediately with `stopOnError: true`)

## Multi-Upstream Slush Merging

When a node depends on multiple parents:

```typescript
// 'report' depends on ['validate', 'transform']
this.context.upstream_slush = {
  validate: { valid: true, errors: [] },
  transform: { rows: 150, format: 'csv' }
}
```

## Key Types

| Type | Fields |
|------|--------|
| `GraphNode` | `name`, `agent`, `kwargs?`, `dependsOn?` |
| `GraphNodeResult` | `name`, `agentName`, `result`, `dataSlush`, `durationMs`, `status` |
| `GraphResult` | `status`, `nodes: Map`, `executionOrder`, `totalDurationMs`, `error?` |
| `GraphOptions` | `nodeTimeout?`, `stopOnError?` |

## Files
- `typescript/src/agents/graph.ts`
- `python/openrappter/agents/graph.py`
- Tests: `typescript/src/__tests__/parity/agent-graph.test.ts` (19 tests)

## Related
- [[Agent Composition]]
- [[AgentChain]] — Simpler sequential-only version
- [[Data Slush Pipeline]]

---

#agents #composition #dag
