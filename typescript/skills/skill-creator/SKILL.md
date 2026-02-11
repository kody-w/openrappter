---
name: skill-creator
description: Create new openrappter skills with proper SKILL.md format and metadata.
metadata: {"openclaw":{"emoji":"🛠️","requires":{}}}
---

# Skill Creator

Create new openrappter/ClawHub skills.

## SKILL.md Format

Every skill needs a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does.
metadata: {"openclaw":{"emoji":"🎯","requires":{"bins":["tool-name"]}}}
---

# My Skill

Instructions and documentation for the skill.
```

## Metadata Fields

- `emoji` — display icon
- `requires.bins` — required CLI binaries (all must exist)
- `requires.anyBins` — alternative binaries (at least one must exist)
- `requires.env` — required environment variables
- `requires.config` — required config paths
- `os` — supported operating systems (darwin, linux, win32)
- `install` — installation instructions for dependencies

## Directory Structure

```
my-skill/
  SKILL.md          # Required: skill definition
  scripts/          # Optional: executable scripts
    run.sh
    run.py
```
