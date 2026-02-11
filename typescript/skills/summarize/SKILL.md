---
name: summarize
description: Summarize text, articles, documents, or web pages using AI models.
metadata: {"openclaw":{"emoji":"📋","requires":{}}}
---

# Summarize

Generate summaries of text content using AI.

## Summarize Text

Provide text directly and get a concise summary using the configured AI provider.

## Summarize a URL

```bash
curl -s "https://example.com/article" | \
  sed 's/<[^>]*>//g' | \
  head -500
# Then pass to AI for summarization
```

## Summarize a File

```bash
cat document.txt | head -1000
# Pass to AI for summarization
```

## Options

- **Length**: short (1-2 sentences), medium (paragraph), long (detailed)
- **Format**: bullet points, narrative, key takeaways
- **Focus**: main ideas, action items, technical details
```
