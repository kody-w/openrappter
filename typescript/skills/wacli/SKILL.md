---
name: wacli
description: Send and receive WhatsApp messages via wacli command-line tool.
metadata: {"openclaw":{"emoji":"💚","requires":{"bins":["wacli"]},"install":[{"id":"go","kind":"go","module":"github.com/nicois/wacli@latest","bins":["wacli"],"label":"Install wacli (go)"}]}}
---

# WaCLI

WhatsApp messaging from the command line.

## Setup

```bash
wacli login
# Scan QR code with WhatsApp on your phone
```

## Send a Message

```bash
wacli send --to "+1234567890" --message "Hello from openrappter!"
```

## List Chats

```bash
wacli chats
```

## Read Messages

```bash
wacli messages --chat "+1234567890" --limit 10
```

## Send Media

```bash
wacli send --to "+1234567890" --file /path/to/image.jpg --caption "Check this out"
```
