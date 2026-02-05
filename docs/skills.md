---
layout: default
title: Skills System - openrappter
---

# 🎯 Agents & Skills System

Agents are tools that openrappter uses to interact with your system.

## Built-in Agents

| Agent | Description | Example |
|-------|-------------|---------|
| `Shell` | Execute commands, read/write files | `run ls -la`, `read README.md` |
| `Memory` | Store and recall facts | `remember I like dinosaurs` |
| `LearnNew` | Generate new agents (Python only) | `learn how to fetch weather` |

## Using Agents

### Natural Language

Just describe what you want:

```
🦖 You: run npm test
🦖 openrappter: Running: npm test

✓ All tests passed (42 tests)
```

### Slash Commands

```
/agents      - List all agents
/status      - Show status
/help        - Show help
```

### CLI Options

```bash
# TypeScript
node dist/index.js --list-agents
node dist/index.js --exec Shell "ls"

# Python
openrappter --list-agents
openrappter --exec Shell "ls"
```

## Creating Custom Agents

Both runtimes use the same agent pattern. See `.github/copilot-instructions.md` for the full contract.

### TypeScript Agent

Create `typescript/src/agents/MyAgent.ts`:

```typescript
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class MyAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'MyAgent',
      description: 'Does something cool',
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
    const query = kwargs.query as string;
    return JSON.stringify({ status: 'success', result: query });
  }
}
```

### Python Agent

Create `python/openrappter/agents/my_agent.py`:

```python
from openrappter.agents.basic_agent import BasicAgent
import json

class MyAgent(BasicAgent):
    def __init__(self):
        self.name = 'MyAgent'
        self.metadata = {
            "name": self.name,
            "description": "Does something cool",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "User input"}
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
    
    def perform(self, **kwargs):
        query = kwargs.get('query', '')
        return json.dumps({"status": "success", "result": query})
```

## Agent Execution

Agents run with automatic context enrichment ("data sloshing"):

- **Timeout**: 30 seconds default
- **Output limit**: 2000 characters for shell commands
- **Context**: Temporal, memory, and behavioral signals available via `self.context`

## Security

⚠️ Agents can execute code on your system. Be careful with:

- Custom agents from untrusted sources
- Commands that modify important files
- Scripts with elevated privileges

## Examples

### Shell Operations

```
🦖 You: ls
🦖 openrappter: 
  📁 src
  📁 docs
  📄 README.md
  📄 package.json
```

### Memory

```
🦖 You: remember this project uses TypeScript
🦖 openrappter: Remembered: "this project uses TypeScript"

🦖 You: recall TypeScript
🦖 openrappter: Found 1 matching memories:
  • this project uses TypeScript
```

---

[← Configuration](./config.md) | [Memory →](./memory.md)
