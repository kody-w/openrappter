---
layout: default
title: Configuration - openrappter
---

# ⚙️ Configuration Guide

openrappter stores configuration in `~/.openrappter/config.json`.

## Configuration File

```json
{
  "setupComplete": true,
  "copilotAvailable": true,
  "preferences": {
    "emoji": "🦖",
    "name": "openrappter"
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENRAPPTER_HOME` | Config directory | `~/.openrappter` |
| `OPENRAPPTER_DEBUG` | Enable debug logging | `false` |

## CLI Options

```bash
openrappter [options] [message]

Options:
  -t, --task <task>    Run a single task
  -e, --evolve <n>     Run N evolution ticks
  -d, --daemon         Run as background daemon
  -s, --status         Show status
  -v, --version        Show version
  -h, --help           Show help
```

## Onboarding

Run the setup wizard to configure openrappter:

```bash
openrappter onboard
```

This will:
1. Check for GitHub Copilot CLI
2. Create configuration directory
3. Set up initial preferences

## Data Locations

| File | Purpose |
|------|---------|
| `~/.openrappter/config.json` | Configuration |
| `~/.openrappter/memory.json` | Persistent memory |
| `~/.openrappter/state.json` | Agent state |
| `~/.openrappter/skills/` | Custom skills |

## Reset Configuration

To reset everything:

```bash
rm -rf ~/.openrappter
openrappter onboard
```

---

[← Installation](./install.md) | [Skills →](./skills.md)
