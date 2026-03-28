# BroadcastManager

Send the same message to multiple agents simultaneously. Three execution modes.

## Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **all** | Wait for all agents to complete | Gather multiple perspectives |
| **race** | Return first successful response | Fastest wins (redundancy) |
| **fallback** | Try agents sequentially until success | Graceful degradation |

## Usage

```typescript
import { BroadcastManager } from './agents/broadcast.js';

const bm = new BroadcastManager();
bm.createGroup({
  id: 'debuggers',
  agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'],
  mode: 'race'
});

const result = await bm.broadcast('debuggers', 'analyze this error',
  (agentId, msg) => agents[agentId].execute({ query: msg })
);
```

## Data Slush Behavior

- **race**: Winner's `data_slush` forwarded to downstream
- **fallback**: Slush threaded through sequential attempts
- **all**: All agents' slush collected

## Files
- `typescript/src/agents/broadcast.ts`
- `python/openrappter/agents/broadcast.py`

## Related
- [[Agent Composition]]
- [[AgentRouter]] — Routes to one agent; Broadcast sends to many
- [[Data Slush Pipeline]]

---

#agents #composition #parallel
