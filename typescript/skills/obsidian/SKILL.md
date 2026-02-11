---
name: obsidian
description: Read, create, and search notes in an Obsidian vault from the command line.
metadata: {"openclaw":{"emoji":"💎","requires":{}}}
---

# Obsidian

Work with Obsidian vaults from the command line.

## Read a Note

```bash
cat "$OBSIDIAN_VAULT/Notes/my-note.md"
```

## Create a Note

```bash
cat > "$OBSIDIAN_VAULT/Notes/new-note.md" << 'EOF'
---
tags: [project, ideas]
created: 2024-01-01
---

# New Note

Content goes here.
EOF
```

## Search Notes

```bash
grep -rl "search term" "$OBSIDIAN_VAULT" --include="*.md"
```

## List Recent Notes

```bash
find "$OBSIDIAN_VAULT" -name "*.md" -mtime -7 -type f | sort
```

## Open in Obsidian

```bash
open "obsidian://open?vault=MyVault&file=Notes/my-note"
```
