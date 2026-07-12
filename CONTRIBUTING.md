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

## Releasing npm and PyPI packages

Package releases use one canonical workflow: `.github/workflows/release.yml`.
A strict `vX.Y.Z` tag is accepted only when it matches:

- `typescript/package.json` and both root versions in `typescript/package-lock.json`
- `python/pyproject.toml`
- the TypeScript and Python runtime-reported versions

Update the npm metadata, then update the Python project version and
`python/openrappter/__init__.py`:

```bash
npm version X.Y.Z --no-git-tag-version --prefix typescript
node scripts/release-preflight.mjs --tag vX.Y.Z
node --test scripts/release-preflight.test.mjs
```

The local preflight is deterministic and does not require registry access.
Pushing the tag builds each npm and Python distribution once, reruns the
cycle-11 CI and install gates against those files, and smoke-installs the exact
artifacts. The dependency lock, pinned Python builders, and commit-derived
`SOURCE_DATE_EPOCH` keep rerun artifacts reproducible. Registry publication is
globally serialized. Before either registry is changed, both remote identities
are checked; immediately before each publish, the workflow either confirms the
version is absent or compares the remote npm integrity/PyPI SHA-256 digests
with the local files. Matching files are resumed as complete, missing PyPI
files are published, and any conflict fails closed. npm uses an explicit
dist-tag selected only after comparing stable semantic versions from the
registry and release tags, so an older release cannot replace a newer
`latest`.

npm and PyPI use trusted publishing; the repository publishers must trust
`.github/workflows/release.yml`, and no registry API tokens are used. A
rerun safely completes any remaining registry and then creates or updates the
GitHub Release with generated notes, the distributions, and `SHA256SUMS`.

## Code of Conduct

- Be respectful and inclusive
- Focus on the code, not the person
- Help others learn
