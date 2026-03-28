# macOS Menu Bar App

Native Swift menu bar companion with animated dino tamagotchi.

## Installation

### Homebrew
```bash
brew tap kody-w/tap && brew install --cask openrappter-bar
```

### DMG
Download from the GitHub Releases page.

### From Source
```bash
cd macos
# Build with Xcode
```

> **Note**: App is currently unsigned. First launch: right-click the app → Open to bypass Gatekeeper.

## Dino Tamagotchi Behaviors

| Behavior | Trigger |
|----------|---------|
| Looks around | Idle animation |
| Reacts to pokes | Click the dino |
| Gets excited | 5+ rapid pokes |
| Sleeping | Gateway disconnected |
| Thinking | Agent processing |

## Setup Wizard

Visual onboarding flow:
1. **Welcome** — Introduction
2. **GitHub Auth** — Device code flow for Copilot
3. **Telegram** — Optional bot token setup
4. **Auto-start** — Enable launch on login
5. **Done** — Ready to use

## Features

- Real-time gateway connection status
- Quick access to agent chat
- System tray notifications for cron jobs
- Activity indicator during agent execution

## Related
- [[Getting Started]]
- [[Background Daemon and Cron]]
- [[Integration Checklist]]

---

#guides #macos
