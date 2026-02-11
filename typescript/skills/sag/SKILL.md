---
name: sag
description: Search and Grep - powerful code search across repositories and file systems.
metadata: {"openclaw":{"emoji":"🔎","requires":{"bins":["rg"]}}}
---

# SAG (Search and Grep)

Fast code search using ripgrep.

## Basic Search

```bash
rg "pattern" /path/to/search
```

## Search by File Type

```bash
rg "function" --type ts
rg "class" --type py
```

## Search with Context

```bash
rg "TODO" -C 3
```

## Search and Replace

```bash
rg "old_name" --files-with-matches | xargs sed -i '' 's/old_name/new_name/g'
```

## Useful Flags

- `-i` — case insensitive
- `-w` — whole word match
- `-l` — files only
- `-c` — count matches
- `--hidden` — include hidden files
- `--glob '!node_modules'` — exclude patterns
