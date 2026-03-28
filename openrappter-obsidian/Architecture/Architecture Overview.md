# Architecture Overview

openrappter is a **monorepo** with two interchangeable runtimes (TypeScript and Python) sharing the same agent contract, execution model, and data formats.

## High-Level Topology

```
CLI / UI (Browser)
    |
Gateway Server (WS :18790)
    |-- RPC Methods (showcase, rappter, auth, backup)
    |-- Dashboard REST API (/api/...)
    |-- Agent Registry (discovers agents)
    +-- Channel Registry (Slack, Discord, Telegram, etc.)
        |
    Agent Executor
    |-- BasicAgent subclasses
    |-- Composition: AgentChain, AgentGraph, AgentRouter, BroadcastManager
    |-- LLM Provider (Copilot, Anthropic, OpenAI, etc.)
    +-- Storage (SQLite)
        |-- Sessions
        |-- Memory Chunks
        |-- Cron Jobs
        +-- Devices
```

## Execution Flow

Every agent invocation follows this path:

```
execute(kwargs)
  -> slosh(query)          # Enrich with temporal, memory, behavioral signals
  -> merge upstream_slush  # Receive data from previous agent in chain
  -> perform(kwargs)       # Subclass logic runs here
  -> extract data_slush    # Curated output signals for downstream agents
```

See [[Data Sloshing]] and [[Data Slush Pipeline]] for details.

## Agent Discovery

Both runtimes use an `AgentRegistry` that:
1. Scans the built-in agents directory (`*Agent.ts` / `*_agent.py`)
2. Scans user agents at `~/.openrappter/agents/`
3. Loads [[Skills and ClawHub|ClawHub skills]] from `~/.openrappter/skills/`

## Tool-Call Loop

The [[LLM Providers|LLM provider]] orchestrates agents through a tool-calling loop:

```
User message -> LLM (Copilot/Claude/GPT)
  -> Tool call: agent.execute({...})
  -> Result returned to LLM
  -> LLM decides: more tools or final response
  -> Repeat until done
```

## Key Directories

| Path | Purpose |
|------|---------|
| `typescript/src/agents/` | TypeScript agent implementations |
| `typescript/src/gateway/` | WebSocket server + REST API |
| `typescript/src/channels/` | Messaging platform integrations |
| `typescript/src/memory/` | Vector + FTS memory system |
| `typescript/src/storage/` | SQLite persistence |
| `typescript/src/providers/` | LLM model providers |
| `typescript/src/mcp/` | MCP protocol server |
| `typescript/ui/` | Lit web component dashboard |
| `python/openrappter/agents/` | Python agent implementations |
| `~/.openrappter/` | User data (memory, config, agents, skills) |

## Related
- [[Single File Agent Pattern]]
- [[Gateway Server]]
- [[Agent Index]]
- [[LLM Providers]]
- [[Dashboard UI]]

---

#architecture
