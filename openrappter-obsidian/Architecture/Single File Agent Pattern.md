# Single File Agent Pattern

The core design principle: **one file = one agent**. Metadata, documentation, and code all live together using native language constructs. No YAML. No config files. The code IS the contract.

## TypeScript Pattern

```typescript
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class MyAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'MyAgent',
      description: 'What this agent does',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'User input' }
        },
        required: []
      }
    };
    super('MyAgent', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({ status: 'success', result: '...' });
  }
}
```

## Python Pattern

```python
from openrappter.agents.basic_agent import BasicAgent
import json

class MyAgent(BasicAgent):
    def __init__(self):
        self.name = 'MyAgent'
        self.metadata = {
            "name": self.name,
            "description": "What this agent does",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "result": "..."})
```

## Conventions

| Rule | Detail |
|------|--------|
| **File naming** | `*Agent.ts` (TypeScript), `*_agent.py` (Python) |
| **Metadata format** | OpenAI tools schema: `name`, `description`, `parameters` |
| **Entry point** | `execute()` called by orchestrator |
| **Override** | `perform()` — the abstract method you implement |
| **Return format** | JSON string: `{"status": "success|error", ...}` |

## Related
- [[BasicAgent]]
- [[Creating an Agent]]
- [[LearnNewAgent]] — Generates agents following this pattern

---

#architecture #agents
