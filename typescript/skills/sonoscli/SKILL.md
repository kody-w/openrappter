---
name: sonoscli
description: Control Sonos speakers from the command line via sonoscli.
metadata: {"openclaw":{"emoji":"🔊","requires":{"bins":["sonoscli"]},"install":[{"id":"brew","kind":"brew","formula":"sonoscli","bins":["sonoscli"],"label":"Install sonoscli (brew)"}]}}
---

# SonosCLI

Control Sonos speakers from the terminal.

## List Speakers

```bash
sonoscli list
```

## Play/Pause

```bash
sonoscli play --room "Living Room"
sonoscli pause --room "Living Room"
```

## Volume Control

```bash
sonoscli volume set --room "Living Room" --level 40
sonoscli volume up --room "Living Room"
sonoscli volume down --room "Living Room"
```

## Group Speakers

```bash
sonoscli group "Living Room" "Kitchen"
sonoscli ungroup "Kitchen"
```

## Now Playing

```bash
sonoscli status --room "Living Room"
```
