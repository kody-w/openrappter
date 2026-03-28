# Agent Composition

openrappter provides five composition patterns for multi-agent orchestration. All support automatic [[Data Slush Pipeline|data_slush]] forwarding.

## Patterns at a Glance

| Pattern | When to Use | Execution |
|---------|-------------|-----------|
| [[AgentChain]] | Steps must run in order | Sequential |
| [[AgentGraph]] | Steps have dependencies, some can parallelize | DAG (parallel where possible) |
| [[AgentRouter]] | Route messages to different agents by rules | Conditional |
| [[BroadcastManager]] | Same message to multiple agents | Parallel (all/race/fallback) |
| SubAgentManager | Agent calls another agent mid-execution | Nested with depth limits |

## Choosing a Pattern

```
Need sequential pipeline?          -> AgentChain
Need parallel + dependencies?      -> AgentGraph
Need routing by sender/channel?    -> AgentRouter
Need fastest of N agents?          -> BroadcastManager (race)
Need agent to call sub-agents?     -> SubAgentManager
Need conditional/loop steps?       -> PipelineAgent
```

## Combining Patterns

Patterns compose naturally:
- AgentGraph nodes can contain AgentChains
- BroadcastManager results feed into AgentGraph
- SubAgentManager calls work inside any pattern

See [[Showcase Demos]] for 20 runnable examples of combined patterns.

## Related
- [[AgentChain]]
- [[AgentGraph]]
- [[AgentRouter]]
- [[BroadcastManager]]
- [[AgentTracer]] — Observability across all patterns
- [[Multi-Agent Patterns]] — Guide with examples

---

#agents #composition
