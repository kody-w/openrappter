---
name: model-usage
description: Track and display AI model token usage, costs, and statistics.
metadata: {"openclaw":{"emoji":"📊","requires":{}}}
---

# Model Usage

Track AI model usage, token counts, and estimated costs.

## View Usage Summary

Display token usage across all providers:

- Total input/output tokens
- Cost estimates per model
- Usage trends over time

## Provider Breakdown

Track usage by provider:

- **Anthropic**: Claude models
- **OpenAI**: GPT models
- **Google**: Gemini models
- **Local**: Ollama models (no cost)

## Export Data

```bash
# Export usage data as JSON
openrappter usage export --format json --since 2024-01-01

# CSV format
openrappter usage export --format csv
```
