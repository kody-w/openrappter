# 🦖 openRAPPter

> **The medium IS the message** — A single-file AI agent that runs locally with zero API keys.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-brightgreen)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue)](https://python.org)

## What is openRAPPter?

openRAPPter is a **local-first AI agent** that requires no API keys, no cloud accounts, and no monthly bills. It leverages the GitHub Copilot SDK to provide intelligent assistance directly in your terminal.

```bash
# One command to start chatting
npx openrappter
```

### ✨ Key Features

- 🔐 **Zero API Keys** — Uses your existing GitHub Copilot subscription
- 🏠 **Local-First** — All data stays on your machine
- 🧠 **Memory** — Remembers context across sessions
- 🎯 **Skills** — Extensible tool system (bash, files, web)
- 🔄 **Evolution** — Autonomous background processing
- 📦 **Single File** — One Python file, no complex setup

## Quick Start

### Prerequisites

- [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/) installed and authenticated
- Node.js 22+ or Python 3.10+

### Install

```bash
# NPM (recommended)
npm install -g openrappter

# Or run directly
npx openrappter

# Or Python standalone
curl -O https://raw.githubusercontent.com/kody-w/openrappter/main/RAPPagent.py
python RAPPagent.py
```

### First Run

```bash
# Interactive chat
openrappter

# Run a single task
openrappter --task "explain this codebase"

# Autonomous mode (evolves in background)
openrappter --evolve 10

# Daemon mode
openrappter --daemon
```

## Documentation

📚 Full documentation at **[kody-w.github.io/openrappter](https://kody-w.github.io/openrappter)**

- [Installation Guide](https://kody-w.github.io/openrappter/install)
- [Configuration](https://kody-w.github.io/openrappter/config)
- [Skills System](https://kody-w.github.io/openrappter/skills)
- [Memory & Context](https://kody-w.github.io/openrappter/memory)
- [API Reference](https://kody-w.github.io/openrappter/api)

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    openRAPPter 🦖                       │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ Memory  │  │ Skills  │  │ Evolver │  │   LLM   │    │
│  │ Store   │  │ System  │  │ Engine  │  │ Bridge  │    │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘    │
│       │            │            │            │          │
│       └────────────┴────────────┴────────────┘          │
│                         │                               │
│              ┌──────────▼──────────┐                    │
│              │  GitHub Copilot SDK │                    │
│              │   (No API Key!)     │                    │
│              └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

## Why openRAPPter?

| Feature | openRAPPter | Cloud AI Agents |
|---------|-------------|-----------------|
| API Keys Required | ❌ No | ✅ Yes |
| Monthly Cost | $0* | $20-100+ |
| Data Privacy | 🏠 Local | ☁️ Cloud |
| Setup Time | 1 minute | 10-30 minutes |
| Works Offline | ✅ Yes** | ❌ No |

*Requires GitHub Copilot subscription ($10/mo or free for students/OSS)  
**With local LLM fallback

## Skills

openRAPPter comes with built-in skills:

| Skill | Description |
|-------|-------------|
| `bash` | Execute shell commands |
| `read` | Read file contents |
| `write` | Write/create files |
| `list` | List directory contents |
| `remember` | Store facts in memory |
| `recall` | Search memory |

Add custom skills by creating a `skills/` directory:

```yaml
# skills/my-skill.yaml
name: my-skill
description: Does something cool
parameters:
  - name: input
    type: string
script: |
  echo "Processing: $input"
```

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
# Clone and setup
git clone https://github.com/kody-w/openrappter.git
cd openrappter
npm install
npm test
```

## License

MIT © [Kody W](https://github.com/kody-w)

---

<p align="center">
  <b>🦖 The velociRAPPter in your terminal</b><br>
  <i>Built with the GitHub Copilot SDK</i>
</p>
