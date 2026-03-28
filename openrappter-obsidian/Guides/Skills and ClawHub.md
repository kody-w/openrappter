# Skills and ClawHub

Community-contributed agent skills discoverable via GitHub and installable to `~/.openrappter/skills/`.

## What Are Skills?

Skills are `SKILL.md` files with YAML frontmatter that describe an agent capability. They can include executable scripts (Python or shell) in a `scripts/` directory.

## Skill Format

```
owner/repo/
├── skill.json           # Metadata for discovery
├── SKILL.md             # YAML frontmatter + description
└── scripts/             # Optional executable scripts
    ├── run.py
    └── setup.sh
```

### SKILL.md

```markdown
---
name: Git Automation
description: Automated git workflow with smart commits
version: 1.0.0
tags: [git, automation]
---

# Git Automation Skill

This skill automates common git workflows...
```

## Discovery & Installation

```bash
# Search GitHub for skills
openrappter clawhub search "git automation"

# Install a skill
openrappter clawhub install owner/repo
```

Skills are discovered via GitHub `topic:openrappter-skill`.

## How Skills Become Agents

`ClawHubSkillAgent` wraps each skill as a [[BasicAgent]] subclass:
1. `ClawHubClient` searches GitHub for skills
2. Verifies `skill.json` at repository root
3. Parses `SKILL.md` for metadata
4. Wraps as `ClawHubSkillAgent` extending BasicAgent
5. Registers in AgentRegistry

## RappterHub

Community marketplace for sharing agents:

```bash
openrappter rappterhub search "git helper"
openrappter rappterhub install kody-w/git-helper
```

## Lock File

Installed skills tracked at `~/.openrappter/skills/.clawhub/lock.json`.

## Files
- `typescript/src/clawhub.ts` — Client + SkillAgent
- `python/openrappter/clawhub.py` — Python client
- `typescript/src/skills/registry.ts` — Skill registry

## Related
- [[Agent Index]]
- [[Getting Started]]

---

#guides #skills
