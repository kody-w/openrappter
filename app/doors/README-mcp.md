# rappter-doors-mcp: the doors for any MCP client

Install: `app/doors/install.sh` (copies it to `~/bin`). Each new client (by its MCP name) is approved by you on the notch.

- Claude Code: `claude mcp add openrappter-doors -- ~/bin/rappter-doors-mcp`
- Copilot CLI: add to `~/.copilot/mcp-config.json`: `{"mcpServers": {"openrappter-doors": {"type": "local", "command": "~/bin/rappter-doors-mcp", "args": [], "tools": ["*"]}}}` (or `--additional-mcp-config @file` for one run)
- Any MCP client: `{"mcpServers": {"openrappter-doors": {"command": "/Users/<you>/bin/rappter-doors-mcp", "args": []}}}`

Tools: one per door (`reminders_open`, `notes_publish`, …). If OpenRappter is not running, a call says so in plain words.
