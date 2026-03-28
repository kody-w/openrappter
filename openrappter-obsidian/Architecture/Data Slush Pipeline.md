# Data Slush Pipeline

Data slush is the **agent-to-agent signal forwarding** mechanism. When an agent returns a `data_slush` key in its JSON output, the framework extracts it and makes it available to downstream agents.

## How It Works

```
Agent A: perform() returns { status: "success", data_slush: { score: 95, tags: ["urgent"] } }
  -> Framework extracts data_slush to lastDataSlush / last_data_slush
  -> Next agent receives it as upstream_slush in context

Agent B: this.context.upstream_slush = { score: 95, tags: ["urgent"] }
```

## In Agent Chains

[[AgentChain]] automatically threads data_slush between steps.

## In Agent Graphs

[[AgentGraph]] merges slush from **multiple upstream nodes**, keyed by node name.

## In Broadcasts

[[BroadcastManager]] in `race` mode forwards the winner's `data_slush`. In `fallback` mode, threads slush through sequential attempts.

## Producing Data Slush

Return it in your agent's `perform()` output:

```typescript
async perform(kwargs) {
  const result = await doWork(kwargs);
  return JSON.stringify({
    status: 'success',
    result: result.summary,
    data_slush: {
      processed_count: result.count,
      confidence: result.score
    }
  });
}
```

## Related
- [[Data Sloshing]] — Implicit context enrichment (input side)
- [[Agent Composition]] — Chains, graphs, and broadcasts
- [[BasicAgent]]

---

#architecture #data-slush
