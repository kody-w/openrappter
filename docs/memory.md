---
layout: default
title: Memory System - openrappter
---

# 🧠 Memory System

openrappter has persistent memory that survives across sessions.

## How It Works

Memory is stored locally in `~/.openrappter/memory.json`. Each memory entry includes:

- **ID**: Unique identifier
- **Content**: The actual memory
- **Tags**: Optional categorization
- **Created**: Timestamp
- **Accessed**: Access count

## Adding Memories

### Natural Language

```
🦖 You: remember that this project uses PostgreSQL
🦖 openrappter: Got it! I'll remember that. (ID: abc123)
```

### Alternative Phrases

- `remember that...`
- `save that...`
- `store this: ...`

## Searching Memory

### Natural Language

```
🦖 You: what do you remember about databases?
🦖 openrappter: Here's what I remember:
• This project uses PostgreSQL
• Database migrations are in db/migrations/
```

### Slash Command

```
/memory          # Show recent memories
/memory search   # Search all memories
```

## Managing Memory

### Forget a Memory

```
🦖 You: /forget abc123
🦖 openrappter: Forgot memory abc123
```

### View All Memories

```
🦖 You: /memory
🦖 openrappter: Recent memories:
• [abc123] This project uses PostgreSQL...
• [def456] Deploy command is npm run deploy...
```

## Memory Structure

```json
{
  "id": "abc123",
  "content": "This project uses PostgreSQL for the database",
  "tags": ["tech", "database"],
  "created": "2025-02-05T00:00:00.000Z",
  "accessed": 3
}
```

## Auto-Learning

When running in daemon mode or with evolution enabled, openrappter automatically:

1. **Learns project context** from README files
2. **Consolidates old memories** to save space
3. **Prioritizes frequently accessed** memories

## Memory Limits

- Default limit: 100 memories
- When exceeded, least-accessed memories are removed
- Override with `OPENRAPPTER_MEMORY_LIMIT`

## Privacy

All memories are stored **locally**:

- Stored in `~/.openrappter/memory.json` on your machine
- Not shared with third-party services
- You control your data

## Exporting Memory

```bash
# View raw memory file
cat ~/.openrappter/memory.json

# Backup memories
cp ~/.openrappter/memory.json ~/backup/

# Clear all memories
rm ~/.openrappter/memory.json
```

---

[← Skills](./skills.md) | [API Reference →](./api.md)
