---
name: mcporter
description: Import and export MCP (Model Context Protocol) server configurations between tools.
metadata: {"openclaw":{"emoji":"🔌","requires":{"bins":["mcporter"]},"install":[{"id":"npm","kind":"npm","module":"mcporter","bins":["mcporter"],"label":"Install mcporter (npm)"}]}}
---

# MCPorter

Manage MCP server configurations across tools.

## List MCP Servers

```bash
mcporter list
```

## Export Configuration

```bash
mcporter export --format json > mcp-servers.json
```

## Import Configuration

```bash
mcporter import mcp-servers.json
```

## Sync Between Tools

```bash
mcporter sync --from claude --to cursor
```
