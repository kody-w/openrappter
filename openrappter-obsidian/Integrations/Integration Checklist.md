# Integration Checklist

Status of external service connections for the [[Productivity Stack Plan]].

## LLM Providers

| Provider | Status | Auth | Notes |
|----------|--------|------|-------|
| GitHub Copilot | Available | GitHub token (device code) | Default, no extra cost |
| Anthropic | Available | `ANTHROPIC_API_KEY` env var | Claude models |
| OpenAI | Available | `OPENAI_API_KEY` env var | GPT-4 etc. |
| Google Gemini | Available | `GEMINI_API_KEY` env var | Gemini models |
| Ollama | Available | None (local) | Self-hosted models |

## Messaging Channels

| Channel | Status | What's Needed |
|---------|--------|---------------|
| CLI | Ready | Nothing — works out of the box |
| Slack | Ready (needs token) | `SLACK_BOT_TOKEN` |
| Discord | Ready (needs token) | `DISCORD_BOT_TOKEN` |
| Telegram | Ready (needs token) | `TELEGRAM_BOT_TOKEN` |
| iMessage | Ready (macOS only) | macOS + daemon |
| Signal | Ready (needs CLI) | signal-cli daemon |
| WhatsApp | Ready (needs Twilio) | Twilio account or Cloud API |
| Teams | Ready (needs app) | Azure app registration |
| Google Chat | Ready (needs SA) | Service account |
| Matrix | Ready (needs server) | Homeserver URL + token |

## Productivity Stack Features

From [[Productivity Stack Plan]]:

| Feature | Status | Blocker |
|---------|--------|---------|
| Automated code monitoring | Stub | GitHub/GitLab API access |
| Workspace doc scanning | Available | Can scan local folders |
| Daily action digest | Stub | CI + messaging integration |
| Hacker News pipeline | Available | Web fetch works |
| Priority email triage | Stub | Email API (IMAP/Gmail OAuth) |
| Weekly accomplishment report | Stub | Aggregated dev data |
| Project board automation | Stub | Jira/Trello API tokens |
| Brainstorm/notes intake | Available | Local notes directory |
| Context switch detection | Stub | Activity monitor access |
| Time use analysis | Stub | Shell access for basic audit |

## macOS Menu Bar App

| Feature | Status |
|---------|--------|
| DMG install | Available |
| Homebrew install | `brew tap kody-w/tap && brew install --cask openrappter-bar` |
| Dino tamagotchi | Working |
| GitHub auth wizard | Working |
| Telegram setup wizard | Working |
| Code signing | Unsigned (right-click → Open to bypass Gatekeeper) |

## Related
- [[Productivity Stack Plan]]
- [[Channel Index]]
- [[LLM Providers]]
- [[Getting Started]]

---

#integrations #checklist
