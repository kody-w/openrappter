# Getting Started

## Prerequisites

- **TypeScript runtime**: Node.js >= 20.0.0
- **Python runtime**: Python >= 3.10
- **LLM**: GitHub Copilot subscription (default, no extra cost) or API key for Anthropic/OpenAI/Gemini

## Installation

### One-Line Install (macOS/Linux/WSL)

```bash
curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://kody-w.github.io/openrappter/install.ps1 | iex
```

### From Source

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter
```

**TypeScript:**
```bash
cd typescript
npm install
npm run build
npm start
```

**Python:**
```bash
cd python
pip install -e .
openrappter --status
```

## First Run

### TypeScript CLI
```bash
cd typescript
npm start                    # Interactive mode
npm run demo                 # Quick demo (zero API keys)
```

### Python CLI
```bash
openrappter                           # Interactive mode
openrappter --task "list files"       # One-shot task
openrappter --list-agents             # See available agents
```

## Configuration

Config lives at `~/.openrappter/config.yaml`:

```yaml
# LLM provider (copilot is default)
provider: copilot

# Optional: channel tokens
channels:
  slack:
    token: ${SLACK_BOT_TOKEN}

# Optional: memory settings
memory:
  embedding_provider: openai
```

See [[Config System]] for hot-reload and environment variable substitution.

## User Data Directory

Everything is local at `~/.openrappter/`:

```
~/.openrappter/
├── config.yaml          # Configuration
├── memory.json          # Stored memories
├── agents/              # User-generated agents (via LearnNewAgent)
├── skills/              # ClawHub skills
├── workspace/           # IDENTITY.md, workspace files
└── data.db              # SQLite database (sessions, cron, etc.)
```

## Next Steps
- [[Creating an Agent]] — Build your first custom agent
- [[Multi-Agent Patterns]] — Chain, graph, route, broadcast
- [[Soul Templates]] — Pick a persona
- [[Channel Index]] — Connect messaging platforms
- [[Showcase Demos]] — 20 runnable pattern demos

---

#guides #getting-started
