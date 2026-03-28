# MCP Server

Exposes openrappter agents as MCP (Model Context Protocol) tools via JSON-RPC 2.0 over stdio. Enables Claude Code, Cursor, and other MCP clients to discover and invoke agents.

## Methods

| Method | Description |
|--------|-------------|
| `initialize` | Server info + capabilities |
| `tools/list` | Agent metadata as MCP tool definitions |
| `tools/call` | Route to `agent.execute()` |
| `ping` | Keepalive |

## Mapping

Agent `name` → tool name, `description` → tool description, `parameters` → `inputSchema`.

## Files
- `typescript/src/mcp/server.ts`
- Tests: 18 tests

## Related
- [[Architecture Overview]]
- [[Gateway Server]]

---

#architecture #mcp
