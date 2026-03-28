# Multi-Agent Patterns

Practical guide to composing agents. See [[Agent Composition]] for the reference.

## Pattern 1: Sequential Pipeline (AgentChain)

**Use when**: Steps must run in order, each feeding the next.

```typescript
const chain = new AgentChain()
  .add('fetch', webAgent, { url: 'https://api.example.com/data' })
  .add('analyze', analysisAgent)
  .add('report', reportAgent);

const result = await chain.run();
```

Data flows: fetch → analyze → report via `data_slush` / `upstream_slush`.

---

## Pattern 2: Parallel DAG (AgentGraph)

**Use when**: Some steps can run in parallel, others have dependencies.

```typescript
const graph = new AgentGraph()
  .addNode({ name: 'git',    agent: gitAgent })
  .addNode({ name: 'deps',   agent: depsAgent })
  .addNode({ name: 'complexity', agent: complexityAgent })
  .addNode({ name: 'report', agent: reportAgent,
             dependsOn: ['git', 'deps', 'complexity'] });

await graph.run();
// git, deps, complexity run in parallel
// report runs after all three finish, gets merged upstream_slush
```

---

## Pattern 3: Fastest Wins (BroadcastManager race)

**Use when**: Multiple agents can solve the same problem; you want the fastest.

```typescript
const bm = new BroadcastManager();
bm.createGroup({ id: 'solvers', agentIds: ['A', 'B', 'C'], mode: 'race' });
const winner = await bm.broadcast('solvers', 'solve X', executor);
```

---

## Pattern 4: Routing (AgentRouter)

**Use when**: Different messages should go to different agents.

```typescript
const router = new AgentRouter();
router.addRule({ id: 'code', priority: 10, conditions: { pattern: /code|review/ }, agentId: 'CodeReview' });
router.addRule({ id: 'git',  priority: 5,  conditions: { pattern: /commit|branch/ }, agentId: 'Git' });
router.setDefaultAgent(generalAgent);
```

---

## Pattern 5: Fallback Chain (BroadcastManager fallback)

**Use when**: Try agents in order until one succeeds.

```typescript
bm.createGroup({ id: 'providers', agentIds: ['Primary', 'Secondary', 'Tertiary'], mode: 'fallback' });
```

---

## Pattern 6: Conditional Pipeline (PipelineAgent)

**Use when**: Steps should run only if conditions from previous steps are met.

```typescript
// Step runs only if previous step's data_slush.needs_new_agent === true
{ agent: creatorAgent, condition: { field: 'needs_new_agent', equals: true } }
```

---

## Combining Patterns

Real-world scenarios combine patterns:

```
BroadcastManager (race 3 analyzers)
  -> winner's data_slush feeds into
AgentGraph (parallel post-processing)
  -> results merged into
AgentChain (sequential report generation)
```

See [[Showcase Demos]] for 20 working examples.

## Related
- [[Agent Composition]]
- [[AgentChain]]
- [[AgentGraph]]
- [[AgentRouter]]
- [[BroadcastManager]]

---

#guides #composition
