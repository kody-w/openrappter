# Channel Architecture

All messaging platforms extend `BaseChannel`, providing a uniform interface regardless of the underlying protocol.

## BaseChannel Interface

```typescript
abstract class BaseChannel {
  // Lifecycle
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Messaging
  abstract send(conversationId: string, message: OutgoingMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;

  // Status
  getStatus(): ChannelStatus;
  getInfo(): ChannelInfo;

  // Config
  setConfig(config: Record<string, string>): void;
  getConfig(): Record<string, string>;    // redacts secrets
  getConfigFields(): ConfigField[];        // describes needed config
}
```

## Message Types

```typescript
interface IncomingMessage {
  channel: string;
  sender: string;
  conversationId: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

interface OutgoingMessage {
  text: string;
  metadata?: Record<string, unknown>;
}
```

## ChannelRegistry

```typescript
const registry = new ChannelRegistry();
registry.register(new SlackChannel(config));
registry.register(new DiscordChannel(config));

await registry.connectAll();

// Route a message
const slack = registry.get('slack');
await slack.send(conversationId, { text: 'Hello from openrappter!' });

// Status
const statuses = registry.getStatusList();
await registry.disconnectAll();
```

## Config Redaction

Tokens and secrets are automatically masked in `getConfig()` output:
- `xoxb-1234-abcd` → `xoxb-****-****`

## Files
- `typescript/src/channels/base.ts` — Abstract base
- `typescript/src/channels/types.ts` — Type definitions
- `typescript/src/channels/registry.ts` — ChannelRegistry

## Related
- [[Channel Index]]
- [[AgentRouter]] — Route by channel
- [[Gateway Server]] — Channels connect via gateway

---

#channels #architecture
