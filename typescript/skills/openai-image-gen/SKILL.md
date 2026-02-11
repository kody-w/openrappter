---
name: openai-image-gen
description: Generate images using OpenAI's DALL-E API.
metadata: {"openclaw":{"emoji":"🖼️","requires":{"env":["OPENAI_API_KEY"]},"primaryEnv":"OPENAI_API_KEY"}}
---

# OpenAI Image Generation

Generate images with DALL-E via the OpenAI API.

## Generate an Image

```bash
curl -s "https://api.openai.com/v1/images/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "A serene mountain landscape at sunset",
    "n": 1,
    "size": "1024x1024"
  }' | jq '.data[0].url'
```

## Edit an Image

```bash
curl -s "https://api.openai.com/v1/images/edits" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F image="@original.png" \
  -F mask="@mask.png" \
  -F prompt="Add a rainbow in the sky" \
  -F n=1 \
  -F size="1024x1024" | jq '.data[0].url'
```

## Variations

```bash
curl -s "https://api.openai.com/v1/images/variations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F image="@original.png" \
  -F n=3 \
  -F size="1024x1024" | jq '.data[].url'
```
