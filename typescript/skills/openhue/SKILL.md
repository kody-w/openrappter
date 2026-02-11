---
name: openhue
description: Control Philips Hue lights and scenes via the OpenHue CLI.
homepage: https://www.openhue.io/cli
metadata: {"openclaw":{"emoji":"💡","requires":{"bins":["openhue"]},"install":[{"id":"brew","kind":"brew","formula":"openhue-cli","bins":["openhue"],"label":"Install OpenHue CLI (brew)"}]}}
---

# OpenHue

Control Philips Hue lights from the command line.

## List Lights

```bash
openhue get lights
```

## Turn On/Off

```bash
openhue set light "Living Room" --on true
openhue set light "Bedroom" --on false
```

## Set Color and Brightness

```bash
openhue set light "Desk Lamp" --brightness 80 --color "#FF6B35"
```

## Scenes

```bash
# List scenes
openhue get scenes

# Activate a scene
openhue set scene "Movie Night"
```

## Rooms

```bash
openhue get rooms
openhue set room "Office" --on true --brightness 100
```
