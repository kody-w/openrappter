# AgentChain

Sequential agent pipeline with automatic `data_slush` forwarding between steps. Fluent builder API.

## Usage

```typescript
import { AgentChain } from './agents/chain.js';

const chain = new AgentChain()
  .add('fetch', webAgent, { url: 'https://...' })
  .add('parse', parseAgent)    // receives fetch's data_slush
  .add('store', memAgent);     // receives parse's data_slush

const result = await chain.run();
```

## Features

| Feature | Description |
|---------|-------------|
| **Auto slush forwarding** | Each step's `data_slush` becomes next step's `upstream_slush` |
| **Transforms** | Optional function to reshape data between steps |
| **stopOnError** | Halt chain on first failure (default) or continue |
| **Timeouts** | Per-step timeout configuration |

## Transforms

Reshape output before passing to next step:

```typescript
chain.add('evolve', evolutionAgent)
  .add('review', reviewAgent, {}, (result) => ({
    content: JSON.parse(result).evolved_source
  }));
```

## Files
- `typescript/src/agents/chain.ts`
- `python/openrappter/agents/chain.py`

## Related
- [[Agent Composition]]
- [[AgentGraph]] — For DAG (non-linear) pipelines
- [[Data Slush Pipeline]]

---

#agents #composition
