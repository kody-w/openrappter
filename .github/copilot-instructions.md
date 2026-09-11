# Copilot Instructions for openrappter

## Build, Test, and Lint

### TypeScript
```bash
cd typescript
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc)
npm run dev          # Development mode with hot reload
npm test             # Run tests (vitest)
npm run lint         # ESLint
```

### Python
```bash
cd python
pip install -e .                    # Install in editable mode
openrappter --status                # Verify CLI works
openrappter --list-agents           # List discovered agents

# Or run without installing:
python -m openrappter.cli --status
```

## Architecture

openrappter is a **monorepo** with two interchangeable runtimes:

```
openrappter/
├── python/                    # Python runtime
│   ├── openrappter/
│   │   ├── cli.py            # Entry point & orchestrator
│   │   └── agents/           # Python agents
│   └── pyproject.toml
├── typescript/               # TypeScript runtime
│   ├── src/
│   │   ├── index.ts          # Entry point
│   │   └── agents/           # TypeScript agents
│   ├── package.json
│   └── tsconfig.json
└── .github/
    └── copilot-instructions.md
```

- **TypeScript CLI** (`typescript/src/index.ts`): Terminal UI using @clack/prompts. Uses `AgentRegistry` to discover agents from `typescript/src/agents/`.

- **Python CLI** (`python/openrappter/cli.py`): Agent orchestration with tool-calling. Uses `AgentRegistry` to discover agents from `python/openrappter/agents/`.

- **Unified Agent Pattern**: Both runtimes use identical agent contracts. Agents can be ported between languages.

### Data Sloshing

All agents automatically receive enriched context before `perform()` is called. This "data sloshing" provides:
- Temporal awareness (time of day, fiscal period, urgency)
- Memory echoes (relevant past interactions)
- Query signals (specificity, ownership hints)
- Behavioral hints (user preferences)
- Orientation (confidence level, suggested approach)
- Upstream slush (live signals from a previous agent in a chain)

Access via `self.context` (Python) or `this.context` (TypeScript), or use `get_signal('key.subkey')` / `getSignal('key.subkey')`.

### Data Slush (Agent-to-Agent Pipeline)

Agents can return a `data_slush` dict in their JSON output — curated signals from live results. The framework extracts this after `perform()` and stores it on `last_data_slush` (Python) / `lastDataSlush` (TypeScript). To chain agents, pass it as `upstream_slush` to the next `execute()` call. The downstream agent receives it in `self.context['upstream_slush']` / `this.context.upstream_slush`.

## Unified Agent Contract

Both TypeScript and Python agents MUST follow this pattern — one file, one agent, metadata defined in native code constructors:

### Python (`python/openrappter/agents/*_agent.py`)

```python
from openrappter.agents.basic_agent import BasicAgent

class MyAgent(BasicAgent):
    def __init__(self):
        self.name = 'MyAgent'
        self.metadata = {
            "name": self.name,
            "description": "What this agent does",
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
        return json.dumps({"status": "success", "result": "..."})
```

### TypeScript (`typescript/src/agents/*Agent.ts`)

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
    const query = kwargs.query as string;
    return JSON.stringify({ status: 'success', result: '...' });
  }
}
```

### Key Rules

1. **File naming**: `*Agent.ts` for TypeScript, `*_agent.py` for Python (auto-discovered)
2. **Metadata**: OpenAI tools format with `name`, `description`, `parameters` — defined in native code
3. **Entry point**: `execute()` is called by orchestrator (handles sloshing), which calls `perform()`
4. **Return format**: JSON string with `{"status": "success|error", ...}`
5. **Context access**: `self.context` / `this.context` after sloshing

### Core Agents (both runtimes)

| Agent | TypeScript | Python | Purpose |
|-------|------------|--------|---------|
| Shell | `typescript/src/agents/ShellAgent.ts` | `python/openrappter/agents/shell_agent.py` | Bash, file read/write, directory listing |
| Memory | `typescript/src/agents/MemoryAgent.ts` | `python/openrappter/agents/manage_memory_agent.py` | Store/recall facts |
| LearnNew | — | `python/openrappter/agents/learn_new_agent.py` | Meta-agent that generates new agents |

## Conventions

- Use `kwargs.get('query')` (Python) or `kwargs.query as string` (TypeScript) for input
- Return informative JSON with `status`, `message`, and relevant data
- Keep agents focused on a single capability
- TypeScript uses ES modules (`"type": "module"`) with strict mode
- Python requires 3.10+
