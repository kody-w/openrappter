---
name: nano-banana-pro
description: Run fast image generation with Nano Banana Pro via local or remote inference.
metadata: {"openclaw":{"emoji":"🍌","requires":{"bins":["curl"]}}}
---

# Nano Banana Pro

Fast image generation using Nano Banana Pro models.

## Generate an Image

```bash
curl -s -X POST "http://localhost:8000/generate" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A sunset over mountains", "width": 512, "height": 512}' \
  --output /tmp/generated.png
```

## With Negative Prompt

```bash
curl -s -X POST "http://localhost:8000/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A photorealistic cat",
    "negative_prompt": "blurry, low quality",
    "steps": 20,
    "cfg_scale": 7.5
  }' --output /tmp/cat.png
```
