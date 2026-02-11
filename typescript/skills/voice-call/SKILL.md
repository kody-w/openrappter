---
name: voice-call
description: Start and manage voice calls via the openrappter voice-call plugin.
metadata: {"openclaw":{"emoji":"📞","requires":{"config":["plugins.entries.voice-call.enabled"]}}}
---

# Voice Call

Make and receive voice calls through the openrappter voice plugin.

## Requirements

Enable the voice-call plugin in openrappter config:

```yaml
plugins:
  entries:
    voice-call:
      enabled: true
```

## Start a Call

```bash
openrappter call start --to "+1234567890"
```

## End a Call

```bash
openrappter call end
```

## Conference Call

```bash
openrappter call conference --participants "+1234567890,+0987654321"
```
