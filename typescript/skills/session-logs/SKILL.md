---
name: session-logs
description: View and manage agent session logs for debugging and auditing.
metadata: {"openclaw":{"emoji":"📜","requires":{"bins":["jq","rg"]}}}
---

# Session Logs

View and analyze agent session logs.

## List Sessions

```bash
ls -la ~/.openrappter/sessions/
```

## View Latest Session

```bash
cat ~/.openrappter/sessions/latest.jsonl | jq '.'
```

## Search Session Logs

```bash
rg "error" ~/.openrappter/sessions/ --type jsonl
```

## Filter by Agent

```bash
cat ~/.openrappter/sessions/*.jsonl | jq 'select(.agent == "ShellAgent")'
```

## Export Session

```bash
jq -s '.' ~/.openrappter/sessions/SESSION_ID.jsonl > export.json
```
