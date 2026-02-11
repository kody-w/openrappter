---
name: songsee
description: Identify songs using audio fingerprinting via Shazam or AudD APIs.
metadata: {"openclaw":{"emoji":"🎵","requires":{"bins":["curl"]}}}
---

# SongSee

Identify songs from audio samples.

## Using AudD API

```bash
curl -s -X POST "https://api.audd.io/" \
  -F file=@audio-sample.mp3 \
  -F api_token="$AUDD_API_TOKEN" \
  -F return="apple_music,spotify" | jq '{title: .result.title, artist: .result.artist}'
```

## From URL

```bash
curl -s -X POST "https://api.audd.io/" \
  -F url="https://example.com/audio.mp3" \
  -F api_token="$AUDD_API_TOKEN" | jq '.result'
```
