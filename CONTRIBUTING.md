# Contributing to openrappter

Thank you for your interest in contributing to openrappter! 🦖

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/openrappter.git
   cd openrappter
   ```

## Repository Structure

This is a monorepo with two runtimes:

```
openrappter/
├── python/           # Python runtime
│   ├── openrappter/  # Package source
│   └── pyproject.toml
├── typescript/       # TypeScript runtime
│   ├── src/          # TypeScript source
│   └── package.json
└── docs/             # Documentation
```

## Development

### TypeScript

```bash
cd typescript
npm install
npm run dev          # Development mode with hot reload
npm run build        # Build
npm test             # Run tests
```

### Python

```bash
cd python
pip install -e .     # Install in editable mode
openrappter --status # Test
```

## Creating Agents

Both runtimes use the same agent pattern. See `.github/copilot-instructions.md` for the full contract.

### TypeScript Agent (`typescript/src/agents/MyAgent.ts`)

```typescript
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class MyAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'MyAgent',
      description: 'What this agent does',
      parameters: { type: 'object', properties: {}, required: [] }
    };
    super('MyAgent', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({ status: 'success', result: '...' });
  }
}
```

### Python Agent (`python/openrappter/agents/my_agent.py`)

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

## Pull Request Process

1. Create a feature branch
2. Make your changes
3. Test both runtimes if applicable
4. Update documentation if needed
5. Submit PR with clear description

## Code of Conduct

- Be respectful and inclusive
- Focus on the code, not the person
- Help others learn
