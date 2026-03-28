# Gateway Server

The WebSocket gateway is the central hub connecting CLI, browser dashboard, and external channels to the agent system.

## Connection Details

| Setting | Value |
|---------|-------|
| **Default port** | 18790 |
| **Protocol** | WebSocket + JSON-RPC 2.0 |
| **Heartbeat** | 30s intervals |
| **Connection timeout** | 120s |
| **Rate limit** | 100 requests/min |

## RPC Methods

| Group | Examples | File |
|-------|----------|------|
| **Rappter** | Agent execution, chat, sessions | `methods/rappter-methods.ts` |
| **Showcase** | `showcase.list`, `showcase.run`, `showcase.runall` | `methods/showcase-methods.ts` |
| **Auth** | GitHub device code login | `methods/auth-methods.ts` |
| **Backup** | Config/data export/import | `methods/backup-methods.ts` |

## Dashboard REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents` | GET | List registered agents |
| `/api/agents/execute` | POST | Execute agent |
| `/api/traces` | GET | Recent execution traces |
| `/api/traces` | DELETE | Clear traces |
| `/api/status` | GET | System status |

## Related
- [[Architecture Overview]]
- [[Dashboard UI]]
- [[MCP Server]]

---

#architecture #gateway
