---
layout: default
title: Installation Guide - openRAPPter
---

# 🦖 Installation Guide

Get openRAPPter running in under 2 minutes.

## Prerequisites

### Required: GitHub Copilot CLI

openRAPPter uses the GitHub Copilot SDK, which requires the Copilot CLI to be installed and authenticated.

```bash
# Install Copilot CLI
npm install -g @githubnext/github-copilot-cli

# Authenticate (opens browser)
github-copilot-cli auth
```

### Required: Node.js 22+

openRAPPter requires Node.js 22 or later.

```bash
# Check your version
node --version

# Install via nvm (recommended)
nvm install 22
nvm use 22
```

## Installation Options

### Option 1: Run Directly (Recommended)

No installation needed — run with npx:

```bash
npx openrappter
```

### Option 2: Global Install

For faster startup times:

```bash
npm install -g openrappter
```

Then run:

```bash
openrappter
```

### Option 3: Python Standalone

For minimal dependencies, use the single-file Python version:

```bash
# Download
curl -O https://raw.githubusercontent.com/kody-w/openrappter/main/RAPPagent.py

# Run (Python 3.10+ required)
python RAPPagent.py
```

## Verify Installation

Check that everything is working:

```bash
# Check status
openrappter --status

# Should show:
# 🦖 openRAPPter Status
#   Version: 1.0.0
#   Copilot: ✅ Available
```

## First Run

Start your first chat:

```bash
openrappter

# Or run a quick task
openrappter --task "what can you do?"
```

## Troubleshooting

### Copilot CLI not found

```bash
# Make sure it's installed
npm install -g @githubnext/github-copilot-cli

# Authenticate if needed
github-copilot-cli auth
```

### Node.js version too old

```bash
# Use nvm to upgrade
nvm install 22
nvm use 22
```

### Permission errors

```bash
# Use sudo for global install (not recommended)
sudo npm install -g openrappter

# Better: fix npm permissions
# https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
```

## Next Steps

- [Configuration Guide](./config.md) — Customize openRAPPter
- [Skills System](./skills.md) — Add custom skills
- [Memory Guide](./memory.md) — Use persistent memory
- [API Reference](./api.md) — All commands and options

---

[← Back to Home](./index.html) | [Configuration →](./config.md)
