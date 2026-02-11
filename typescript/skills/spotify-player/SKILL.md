---
name: spotify-player
description: Control Spotify playback via spotify_player CLI or Spotify Web API.
metadata: {"openclaw":{"emoji":"🎧","requires":{"bins":["spotify_player"]},"install":[{"id":"brew","kind":"brew","formula":"spotify_player","bins":["spotify_player"],"label":"Install spotify_player (brew)"}]}}
---

# Spotify Player

Control Spotify playback from the command line.

## Play/Pause

```bash
spotify_player playback play
spotify_player playback pause
```

## Skip Track

```bash
spotify_player playback next
spotify_player playback previous
```

## Search

```bash
spotify_player search --type track "Bohemian Rhapsody"
```

## Now Playing

```bash
spotify_player get --key playback
```

## Queue

```bash
spotify_player playback queue --uri spotify:track:TRACK_ID
```
