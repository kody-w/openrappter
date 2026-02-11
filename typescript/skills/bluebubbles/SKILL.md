---
name: bluebubbles
description: Send and receive iMessages through BlueBubbles server API.
metadata: {"openclaw":{"emoji":"🫧","requires":{"config":["channels.bluebubbles"]}}}
---

# BlueBubbles

Send and manage iMessages via the BlueBubbles server REST API.

## Requirements

- BlueBubbles server running on a Mac
- API password configured in openrappter config under `channels.bluebubbles`

## Send a Message

```bash
curl -X POST "http://BBSERVER:1234/api/v1/message/text" \
  -H "Content-Type: application/json" \
  -d '{"chatGuid": "iMessage;-;+1234567890", "message": "Hello!", "tempGuid": "'$(uuidgen)'"}'
```

## List Chats

```bash
curl "http://BBSERVER:1234/api/v1/chat?limit=10&offset=0&with=lastMessage"
```

## Get Messages

```bash
curl "http://BBSERVER:1234/api/v1/chat/CHAT_GUID/message?limit=25"
```
