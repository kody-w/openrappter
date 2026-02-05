---
layout: default
title: Skills System - openRAPPter
---

# 🎯 Skills System

Skills are tools that openRAPPter can use to interact with your system.

## Built-in Skills

| Skill | Description | Example |
|-------|-------------|---------|
| `bash` | Execute shell commands | `run ls -la` |
| `read` | Read file contents | `read README.md` |
| `write` | Write to files | `write hello.txt "Hello"` |
| `list` | List directory | `list .` |
| `remember` | Store in memory | `remember I like dinosaurs` |
| `recall` | Search memory | `recall dinosaurs` |

## Using Skills

### Natural Language

Just describe what you want:

```
🦖 You: run npm test
🦖 openRAPPter: Running: npm test

✓ All tests passed (42 tests)
```

### Slash Commands

Use explicit commands:

```
/skills          - List all skills
/memory          - Show recent memories
/forget <id>     - Remove a memory
```

## Custom Skills

Create custom skills in `~/.openrappter/skills/`:

### YAML Format

```yaml
# ~/.openrappter/skills/deploy.yaml
name: deploy
description: Deploy to production
parameters:
  - name: environment
    type: string
    default: staging
script: |
  echo "Deploying to $environment..."
  ./deploy.sh $environment
```

### Python Format

```python
# ~/.openrappter/skills/analyze.py
def execute(code: str) -> str:
    """Analyze code quality."""
    # Your logic here
    return f"Analysis complete: {len(code)} chars"

SKILL_NAME = "analyze"
SKILL_DESC = "Analyze code quality"
```

## Skill Execution

Skills run in a sandboxed environment:

- **Timeout**: 30 seconds default
- **Output limit**: 2000 characters
- **Working directory**: Current directory

## Security

⚠️ Skills can execute code on your system. Be careful with:

- Custom skills from untrusted sources
- Commands that modify important files
- Scripts with elevated privileges

## Examples

### Git Status

```
🦖 You: run git status
🦖 openRAPPter: Running: git status

On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

### Read and Summarize

```
🦖 You: read package.json
🦖 openRAPPter: 
{
  "name": "my-project",
  "version": "1.0.0",
  ...
}
```

### Remember Context

```
🦖 You: remember this project uses TypeScript and Vitest
🦖 openRAPPter: Got it! I'll remember that. (ID: a1b2c3)
```

---

[← Configuration](./config.md) | [Memory →](./memory.md)
