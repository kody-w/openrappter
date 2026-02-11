---
name: himalaya
description: Read, send, and manage email via the Himalaya CLI email client.
homepage: https://github.com/pimalaya/himalaya
metadata: {"openclaw":{"emoji":"📧","requires":{"bins":["himalaya"]},"install":[{"id":"brew","kind":"brew","formula":"himalaya","bins":["himalaya"],"label":"Install himalaya (brew)"}]}}
---

# Himalaya

CLI email client for reading and sending email.

## List Messages

```bash
himalaya list --folder INBOX --page-size 10
```

## Read a Message

```bash
himalaya read --folder INBOX 123
```

## Send Email

```bash
himalaya send --from "me@example.com" --to "you@example.com" --subject "Hello" --body "Message content"
```

## Search

```bash
himalaya search --folder INBOX "keyword"
```

## Manage Folders

```bash
himalaya folder list
himalaya folder create "New Folder"
```
