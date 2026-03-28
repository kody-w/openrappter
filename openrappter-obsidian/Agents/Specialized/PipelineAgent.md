# PipelineAgent

Declarative multi-agent pipeline runner supporting sequential, parallel, conditional, and loop steps.

## Actions

| Action | Description |
|--------|-------------|
| `run` | Execute a pipeline definition |
| `validate` | Check pipeline for errors before running |
| `status` | Current pipeline execution state |

## Step Types

| Type | Description |
|------|-------------|
| **Sequential** | Steps run one after another |
| **Parallel** | Steps run concurrently |
| **Conditional** | Step runs only if condition met |
| **Loop** | Step repeats N times or until condition |

## Conditional Steps

Conditions evaluate `data_slush` values from previous steps:

```typescript
{
  agent: creatorAgent,
  condition: { field: 'needs_new_agent', equals: true }
}
```

`evaluateCondition()` supports:
- `equals` — Exact value match
- `exists` — Field is present and truthy

## Data Slush Threading

Each step's `data_slush` flows to the next step as `upstream_slush`, enabling context-aware pipelines.

## Files
- `typescript/src/agents/PipelineAgent.ts`
- `python/openrappter/agents/pipeline_agent.py`
- Tests: `typescript/src/__tests__/parity/showcase-agent-compiler.test.ts`

## Related
- [[AgentChain]] — Simpler sequential-only pipeline
- [[AgentGraph]] — DAG-based parallel execution
- [[Agent Composition]]
- [[Agent Index]]

---

#agents #specialized #orchestration
