# 🦖 openrappter

> **The medium IS the message** — A local-first AI agent that runs with zero API keys.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue)](https://python.org)

## What is openrappter?

openrappter is a **local-first AI agent** that requires no API keys, no cloud accounts, and no monthly bills. It leverages the GitHub Copilot SDK to provide intelligent assistance directly in your terminal.

This is a **monorepo** with two interchangeable runtimes:
- **TypeScript** (`typescript/`) — Node.js CLI with @clack/prompts UI
- **Python** (`python/`) — Python CLI with agent orchestration

Both runtimes use the same agent pattern, so agents can be easily ported between languages.

## Quick Start

### TypeScript

```bash
cd typescript
npm install
npm run build
node dist/index.js --status
node dist/index.js "remember that I installed openrappter"
```

### Python

```bash
cd python
pip install -e .
openrappter --status
openrappter "remember that I installed openrappter"
```

Or run directly:
```bash
python -m openrappter.cli --status
```

## Repository Structure

```
openrappter/
├── python/                    # Python runtime
│   ├── openrappter/
│   │   ├── cli.py            # Entry point
│   │   └── agents/           # Python agents
│   │       ├── basic_agent.py
│   │       ├── shell_agent.py
│   │       └── ...
│   └── pyproject.toml
├── typescript/               # TypeScript runtime
│   ├── src/
│   │   ├── index.ts
│   │   └── agents/
│   │       ├── BasicAgent.ts
│   │       ├── ShellAgent.ts
│   │       └── ...
│   ├── package.json
│   └── tsconfig.json
├── docs/                     # Documentation
└── .github/
    └── copilot-instructions.md
```

## Agent Pattern

Both runtimes follow the same agent contract. See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for details.

### Core Agents

| Agent | Description |
|-------|-------------|
| `Shell` | Execute bash commands, read/write files |
| `Memory` | Store and recall facts persistently |
| `LearnNew` | Meta-agent that generates new agents (Python only) |

## Documentation

📚 Full documentation at **[kody-w.github.io/openrappter](https://kody-w.github.io/openrappter)**

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © [Kody W](https://github.com/kody-w)
