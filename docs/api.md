---
layout: default
title: API Reference - openrappter
---

# 📚 API Reference

Complete reference for openrappter commands and options.

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

### Orchestrator Class

```python
from openrappter import Orchestrator

orchestrator = Orchestrator()
orchestrator.initialize()  # Load default agent

# Execute a query
response = orchestrator.execute(query="hello")

# List available agents
agents = orchestrator.list_agents()

# Switch to different agent
orchestrator.switch_agent("MyCustomAgent")
```

### BasicAgent Class

```python
from agents.basic_agent import BasicAgent

class MyCustomAgent(BasicAgent):
    def __init__(self):
        self.name = "MyCustomAgent"
        self.metadata = {
            "name": self.name,
            "description": "Does something cool",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "User query"}
                }
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
    
    def perform(self, **kwargs):
        query = kwargs.get('query', '')
        # Access sloshed context via self.context
        temporal = self.get_signal('temporal', {})
        return {"status": "success", "message": f"Processed: {query}"}
```

### Agent Context (Data Sloshing)

```python
# In your perform() method, access enriched context:

# Temporal awareness
time_of_day = self.get_signal('temporal.time_of_day')
is_weekend = self.get_signal('temporal.is_weekend')

# Query signals
specificity = self.get_signal('query_signals.specificity')
hints = self.get_signal('query_signals.hints', [])

# Behavioral patterns
prefers_brief = self.get_signal('behavioral.prefers_brief')

# Synthesized orientation
confidence = self.get_signal('orientation.confidence')
approach = self.get_signal('orientation.approach')
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
    "name": "openrappter"
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
