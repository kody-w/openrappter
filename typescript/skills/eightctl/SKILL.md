---
name: eightctl
description: Control Eight Sleep smart mattress temperature and settings via eightctl CLI.
metadata: {"openclaw":{"emoji":"🛏️","requires":{"bins":["eightctl"]},"install":[{"id":"go","kind":"go","module":"github.com/kodywilson/eightctl@latest","bins":["eightctl"],"label":"Install eightctl (go)"}]}}
---

# EightCtl

Control Eight Sleep smart mattress from the command line.

## Setup

```bash
eightctl auth --email user@example.com --password "..."
```

## Get Status

```bash
eightctl status
```

## Set Temperature

```bash
# Set bed temperature (-100 to 100)
eightctl temp set --side left --level 20
eightctl temp set --side right --level -10
```

## Turn On/Off

```bash
eightctl power on --side left
eightctl power off --side right
```
