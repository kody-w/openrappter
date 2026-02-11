---
name: imsg
description: Send and receive iMessages using AppleScript/osascript on macOS.
metadata: {"openclaw":{"emoji":"💬","os":["darwin"],"requires":{}}}
---

# iMessage

Send and manage iMessages via osascript on macOS.

## Send a Message

```bash
osascript -e '
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "+1234567890" of targetService
    send "Hello from openrappter!" to targetBuddy
  end tell
'
```

## List Recent Chats

```bash
osascript -e '
  tell application "Messages"
    get name of every chat
  end tell
'
```

## Send to Group Chat

```bash
osascript -e '
  tell application "Messages"
    set targetChat to chat "Group Name"
    send "Hello group!" to targetChat
  end tell
'
```
