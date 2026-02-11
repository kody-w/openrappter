---
name: sherpa-onnx-tts
description: Text-to-speech synthesis using sherpa-onnx for local, offline TTS.
metadata: {"openclaw":{"emoji":"🗣️","requires":{"bins":["sherpa-onnx-offline-tts"]},"install":[{"id":"pip","kind":"pip","module":"sherpa-onnx","bins":["sherpa-onnx-offline-tts"],"label":"Install sherpa-onnx (pip)"}]}}
---

# Sherpa-ONNX TTS

Local text-to-speech synthesis using sherpa-onnx.

## Generate Speech

```bash
sherpa-onnx-offline-tts \
  --vits-model=model.onnx \
  --vits-tokens=tokens.txt \
  --output-filename=/tmp/speech.wav \
  "Hello, this is a test of text to speech."
```

## With Speed Control

```bash
sherpa-onnx-offline-tts \
  --vits-model=model.onnx \
  --vits-tokens=tokens.txt \
  --vits-length-scale=0.8 \
  --output-filename=/tmp/fast-speech.wav \
  "Speaking faster now."
```

## Play Audio

```bash
# macOS
afplay /tmp/speech.wav

# Linux
aplay /tmp/speech.wav
```
