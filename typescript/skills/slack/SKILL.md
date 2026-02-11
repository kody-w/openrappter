---
name: slack
description: Send messages, react, pin items, and manage Slack channels and DMs.
metadata: {"openclaw":{"emoji":"💬","requires":{"config":["channels.slack"]}}}
---

# Slack

Control Slack from openrappter.

## Send a Message

```bash
curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C0123456", "text": "Hello from openrappter!"}'
```

## React to a Message

```bash
curl -s -X POST "https://slack.com/api/reactions.add" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C0123456", "name": "thumbsup", "timestamp": "1234567890.123456"}'
```

## List Channels

```bash
curl -s "https://slack.com/api/conversations.list" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" | jq '.channels[] | {name, id}'
```

## Pin a Message

```bash
curl -s -X POST "https://slack.com/api/pins.add" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C0123456", "timestamp": "1234567890.123456"}'
```
