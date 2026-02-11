---
name: openai-whisper
description: Transcribe audio files locally using OpenAI's Whisper model.
metadata: {"openclaw":{"emoji":"🎤","requires":{"bins":["whisper"]},"install":[{"id":"pip","kind":"pip","module":"openai-whisper","bins":["whisper"],"label":"Install whisper (pip)"}]}}
---

# OpenAI Whisper (Local)

Transcribe audio files using the local Whisper model.

## Basic Transcription

```bash
whisper audio.mp3 --model base --output_format txt
```

## With Language Detection

```bash
whisper audio.mp3 --model medium --task transcribe --output_format json
```

## Translation to English

```bash
whisper foreign-audio.mp3 --model medium --task translate
```

## Models

| Model  | Size   | Quality  |
|--------|--------|----------|
| tiny   | 39M    | Basic    |
| base   | 74M    | Good     |
| small  | 244M   | Better   |
| medium | 769M   | Great    |
| large  | 1550M  | Best     |
