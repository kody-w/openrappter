---
name: oracle
description: Query multiple AI models and compare their responses side by side.
metadata: {"openclaw":{"emoji":"🔮","requires":{}}}
---

# Oracle

Query multiple AI models and compare responses.

## Usage

Send the same prompt to multiple providers and compare:

1. Choose models to query (Claude, GPT, Gemini, Ollama)
2. Send the same prompt to each
3. Compare responses side by side

## Example Workflow

```bash
# Query Claude
curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" ...

# Query GPT
curl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" ...

# Query Gemini
curl -s "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=$GEMINI_API_KEY" ...
```

## Best For

- Comparing model capabilities
- Getting diverse perspectives
- Finding the best model for a task
- Fact-checking across models
