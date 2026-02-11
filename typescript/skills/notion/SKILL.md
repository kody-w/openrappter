---
name: notion
description: Read, create, and update Notion pages and databases via the Notion API.
metadata: {"openclaw":{"emoji":"📝","requires":{"env":["NOTION_API_KEY"]},"primaryEnv":"NOTION_API_KEY"}}
---

# Notion

Interact with Notion workspaces via the API.

## Search Pages

```bash
curl -s -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "Meeting Notes"}' | jq '.results[] | {title: .properties.title, id: .id}'
```

## Create a Page

```bash
curl -s -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "DATABASE_ID"},
    "properties": {"Name": {"title": [{"text": {"content": "New Page"}}]}}
  }'
```

## Query a Database

```bash
curl -s -X POST "https://api.notion.com/v1/databases/DATABASE_ID/query" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.results[:5]'
```
