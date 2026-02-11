---
name: gemini
description: Use Google Gemini API for text generation, vision, and multimodal tasks.
metadata: {"openclaw":{"emoji":"♊","requires":{"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY"}}
---

# Gemini

Access Google's Gemini models via the API.

## Text Generation

```bash
curl -s "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Explain quantum computing"}]}]}'
```

## Vision (Image Analysis)

```bash
# Base64 encode an image and send with prompt
IMAGE_B64=$(base64 -i image.jpg)
curl -s "https://generativelanguage.googleapis.com/v1/models/gemini-pro-vision:generateContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents":[{"parts":[
      {"text":"What is in this image?"},
      {"inlineData":{"mimeType":"image/jpeg","data":"'$IMAGE_B64'"}}
    ]}]
  }'
```
