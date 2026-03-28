# Dashboard UI

Web-based dashboard built with **Lit 3.1** web components, connected to the [[Gateway Server]] via WebSocket RPC.

## Components

| Component | File | Description |
|-----------|------|-------------|
| `<openrappter-app>` | `app.ts` | Main shell, view routing |
| `<openrappter-sidebar>` | `sidebar.ts` | Navigation sidebar |
| `<openrappter-chat>` | `chat.ts` | Agent chat interface |
| `<openrappter-agents>` | `agents.ts` | Agent listing + execution UI |
| `<openrappter-channels>` | `channels.ts` | Channel config + management |
| `<openrappter-sessions>` | `sessions.ts` | Conversation history |
| `<openrappter-cron>` | `cron.ts` | Cron job scheduler |
| `<openrappter-config>` | `config.ts` | Config editor |
| `<openrappter-logs>` | `logs.ts` | System logs |
| `<openrappter-devices>` | `devices.ts` | Connected devices |
| `<openrappter-skills>` | `skills.ts` | ClawHub skill browser |
| `<openrappter-showcase>` | `showcase.ts` | Demo runner (see [[Showcase Demos]]) |
| `<openrappter-zen>` | `zen.ts` | Minimal Zen mode |
| `<openrappter-accounts>` | `accounts.ts` | Account/profile |
| `<openrappter-presence>` | `presence.ts` | Online status |
| `<openrappter-debug>` | `debug.ts` | Tracer debug panel |

## Services

| Service | File | Purpose |
|---------|------|---------|
| `gateway.ts` | WebSocket RPC client | `gateway.call(method, params)` |
| `chat.ts` | Chat message handling | Message history, streaming |
| `channels.ts` | Channel management | Connect/disconnect/status |
| `config.ts` | Config loading/saving | Hot-reload |
| `cron.ts` | Cron job API | Schedule management |
| `logs.ts` | Log streaming | Real-time log display |
| `presence.ts` | Presence tracking | Online/offline |
| `markdown.ts` | Markdown rendering | Chat message formatting |

## Adding a New Dashboard Page

Five touch points (documented in CLAUDE.md):

1. **View type** — `app.ts`: Add to `View` union type
2. **Route** — `app.ts` `renderView()`: Add `case` for your view
3. **Title** — `app.ts` `getViewTitle()`: Add title mapping
4. **Sidebar** — `sidebar.ts`: Add nav item with icon
5. **Entry import** — `main.ts`: Import your component

## Gateway RPC Protocol

```typescript
// Connect
const gateway = new GatewayService('ws://localhost:18790');

// Call methods
const agents = await gateway.call('agents.list');
const result = await gateway.call('agents.execute', { agentName: 'Shell', kwargs: { action: 'bash', command: 'ls' } });

// Streaming
gateway.callStream('chat.send', { message: 'hello' }, {
  onChunk: (text) => console.log(text),
  onToolOutput: (output) => console.log(output),
  onDone: () => console.log('done')
});
```

## Files
- `typescript/ui/src/` — All UI source
- `typescript/ui/src/components/` — Lit components
- `typescript/ui/src/services/` — Service layer
- `typescript/ui/src/main.ts` — Entry point
- `typescript/ui/src/types.ts` — RPC protocol types

## Related
- [[Gateway Server]]
- [[Architecture Overview]]
- [[Showcase Demos]]

---

#architecture #ui
