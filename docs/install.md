---
layout: default
title: Installation Guide - openrappter
---

# 🦖 Installation Guide

Get openrappter running in under 2 minutes.

## Prerequisites

### GitHub Copilot CLI (Optional)

openrappter works best with the GitHub Copilot CLI, but functions without it using keyword-based agent matching.

```bash
# Install Copilot CLI (optional)
npm install -g @githubnext/github-copilot-cli

# Authenticate (opens browser)
github-copilot-cli auth
```

### Runtime Requirements

Choose one or both runtimes:

- **TypeScript**: Node.js 18+
- **Python**: Python 3.10+

## Installation Options

### Option 1: TypeScript Runtime

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter/typescript
npm install
npm run build
```

Run:
```bash
node dist/index.js --status
node dist/index.js "hello"
```

### Option 2: Python Runtime

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter/python
pip install -e .
```

Run:
```bash
openrappter --status
openrappter "hello"

# Or without installing:
python3 -m openrappter.cli --status
```

## Verify Installation

### TypeScript
```bash
cd typescript
node dist/index.js --status

# Should show:
# 🦖 openrappter Status
#   Version: 1.1.0
#   Agents: 2 loaded
```

### Python
```bash
cd python
python3 -m openrappter.cli --status

# Should show:
# Agents: 5 loaded
```

## Troubleshooting

### Node.js version too old

```bash
# Use nvm to upgrade
nvm install 18
nvm use 18
```

### Python import errors

```bash
cd python
pip install -e .
```

### Permission errors

```bash
# Better: fix npm permissions
# https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
```

## Next Steps

- [Configuration Guide](./config.md) — Customize openrappter
- [Skills System](./skills.md) — Add custom skills
- [Memory Guide](./memory.md) — Use persistent memory
- [API Reference](./api.md) — All commands and options

---

[← Back to Home](./index.html) | [Configuration →](./config.md)
