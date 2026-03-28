# Channel Index

openrappter supports 18+ messaging platforms through a unified [[Channel Architecture]].

## Supported Channels

| Channel | File | Auth Required |
|---------|------|---------------|
| **CLI** | `cli.ts` | None (local) |
| **Slack** | `slack.ts` | Bot token |
| **Discord** | `discord.ts` | Bot token |
| **Telegram** | `telegram.ts` | Bot token (polling or webhook) |
| **Signal** | `signal.ts` | Signal CLI daemon |
| **iMessage** | `imessage.ts` | macOS daemon |
| **BlueBubbles** | `bluebubbles.ts` | BlueBubbles server |
| **WhatsApp** | `whatsapp.ts` | Twilio or Cloud API |
| **Google Chat** | `googlechat.ts` | Service account |
| **Microsoft Teams** | `teams.ts` | App registration |
| **Matrix** | `matrix.ts` | Homeserver + token |
| **Mattermost** | `mattermost.ts` | Bot token |
| **LINE** | `line.ts` | Channel access token |
| **Feishu (Lark)** | `feishu.ts` | App credentials |
| **Nostr** | `nostr.ts` | Private key |
| **Thread** | `thread.ts` | Thread-based routing |

## Channel Features

All channels support:
- Connect/disconnect lifecycle
- Send messages to conversations
- Receive messages via handlers
- Status tracking
- Config with secret redaction
- Typing indicators (where supported)
- Reactions (where supported)
- Thread replies (where supported)

## Quick Setup

Channels auto-connect when tokens are configured:

```yaml
# ~/.openrappter/config.yaml
channels:
  slack:
    token: ${SLACK_BOT_TOKEN}
  discord:
    token: ${DISCORD_BOT_TOKEN}
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
```

## Files
- `typescript/src/channels/` — All channel implementations
- `typescript/src/channels/registry.ts` — ChannelRegistry
- `typescript/src/channels/base.ts` — BaseChannel abstract class

## Related
- [[Channel Architecture]]
- [[AgentRouter]] — Route messages by channel
- [[Integration Checklist]]

---

#channels #index
