---
name: peekaboo
description: Capture and analyze screenshots on macOS for visual automation and monitoring.
metadata: {"openclaw":{"emoji":"👀","os":["darwin"],"requires":{"bins":["PeekabooServiceHelper"]}}}
---

# Peekaboo

Visual automation and screen capture on macOS.

## Capture Screenshot

```bash
PeekabooServiceHelper capture --output /tmp/screenshot.png
```

## Capture Window

```bash
PeekabooServiceHelper capture --window "Safari" --output /tmp/window.png
```

## Capture Region

```bash
PeekabooServiceHelper capture --region "0,0,800,600" --output /tmp/region.png
```

## Use Cases

- Visual regression testing
- Automated documentation screenshots
- Screen monitoring and alerts
- UI state verification
