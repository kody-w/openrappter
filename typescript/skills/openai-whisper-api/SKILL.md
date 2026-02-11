---
name: openai-whisper-api
description: Transcribe audio using OpenAI's Whisper API (cloud-based, no local model needed).
metadata: {"openclaw":{"emoji":"☁️","requires":{"env":["OPENAI_API_KEY"]},"primaryEnv":"OPENAI_API_KEY"}}
---

# OpenAI Whisper API

Cloud-based audio transcription via OpenAI's API.

## Transcribe Audio

```bash
curl -s "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@audio.mp3" \
  -F model="whisper-1" | jq '.text'
```

## With Timestamps

```bash
curl -s "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@audio.mp3" \
  -F model="whisper-1" \
  -F response_format="verbose_json" \
  -F timestamp_granularities[]="segment" | jq '.segments[] | {start, end, text}'
```

## Translate to English

```bash
curl -s "https://api.openai.com/v1/audio/translations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@foreign-audio.mp3" \
  -F model="whisper-1" | jq '.text'
```
