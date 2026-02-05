---
layout: default
title: API Reference - openRAPPter
---

# 📚 API Reference

Complete reference for openRAPPter commands and options.

## CLI Commands

### Main Command

```bash
openrappter [options] [message]
```

| Option | Description |
|--------|-------------|
| `[message]` | Send a single message |
| `-t, --task <task>` | Run a task and exit |
| `-e, --evolve <n>` | Run N evolution ticks |
| `-d, --daemon` | Run as background daemon |
| `-s, --status` | Show agent status |
| `-v, --version` | Show version |
| `-h, --help` | Show help |

### Examples

```bash
# Interactive mode
openrappter

# Single message
openrappter "hello there"

# Run a task
openrappter --task "list all TypeScript files"

# Evolve 10 times
openrappter --evolve 10

# Background daemon
openrappter --daemon

# Check status
openrappter --status
```

### Onboard Command

```bash
openrappter onboard
```

Runs the interactive setup wizard.

## Slash Commands

Use these in interactive mode:

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/skills` | List available skills |
| `/memory` | Show recent memories |
| `/forget <id>` | Remove a memory |
| `/evolve [n]` | Run evolution ticks |
| `/status` | Show agent status |
| `/quit` | Exit |

## Python API

### RAPPagent Class

```python
from RAPPagent import RAPPagent

agent = RAPPagent()

# Process a message
response = agent.process("hello")

# Run interactive mode
agent.run_interactive()

# Run a single task
result = agent.run_task("explain this code")

# Run as daemon
agent.run_daemon(interval=60)
```

### Memory Class

```python
from RAPPagent import Memory

memory = Memory()

# Add memory
entry = memory.add("important fact", tags=["work"])

# Search
results = memory.search("fact")

# Recall by ID
item = memory.recall("abc123")

# Forget
memory.forget("abc123")

# List all
all_memories = memory.list_all()
```

### Skills Class

```python
from RAPPagent import Skills

skills = Skills()

# Execute a skill
result = skills.execute("bash", command="ls -la")

# Register custom skill
@skills.register("greet", "Say hello")
def greet(name: str) -> str:
    return f"Hello, {name}!"

# List skills
available = skills.list_skills()
```

### Evolver Class

```python
from RAPPagent import Evolver, RAPPagent

agent = RAPPagent()
evolver = Evolver(agent)

# Run one tick
result = evolver.tick()

# Run multiple
for _ in range(10):
    evolver.tick()
```

## Configuration

### Config File

`~/.openrappter/config.json`:

```json
{
  "setupComplete": true,
  "copilotAvailable": true,
  "preferences": {
    "emoji": "🦖",
    "name": "openRAPPter"
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENRAPPTER_HOME` | Config directory | `~/.openrappter` |
| `OPENRAPPTER_DEBUG` | Debug mode | `false` |
| `OPENRAPPTER_MEMORY_LIMIT` | Max memories | `100` |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Configuration error |
| `3` | Copilot CLI not found |

---

[← Memory](./memory.md) | [Back to Home](./index.html)
