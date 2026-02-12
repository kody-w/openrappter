---
name: healthcheck
description: Run system health checks on the openrappter agent framework and connected services.
metadata: {"openclaw":{"emoji":"🏥","requires":{}}}
---

# Healthcheck

Verify openrappter system health and connected services.

## System Check

```bash
# Check Node.js version
node --version

# Check npm packages
npm ls --depth=0

# Verify gateway connectivity
curl -s http://localhost:18790/health
```

## Service Checks

- **Gateway**: WebSocket connection test
- **Storage**: SQLite read/write test
- **Memory**: Embedding service connectivity
- **Channels**: Per-channel auth validation
- **Skills**: Installed skills integrity

## Diagnostics

```bash
# Full diagnostics
openrappter doctor

# Check config validity
openrappter config validate
```
