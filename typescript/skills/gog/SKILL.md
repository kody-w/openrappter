---
name: gog
description: Search and open Google queries from the command line.
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["curl"]}}}
---

# GoG (Google Search)

Perform web searches from the command line.

## Quick Search

```bash
# Open in default browser
open "https://www.google.com/search?q=openrappter+ai+agent"
```

## Fetch Search Results

```bash
curl -s "https://www.google.com/search?q=your+query" \
  -H "User-Agent: Mozilla/5.0" | \
  grep -oP '(?<=<h3[^>]*>)[^<]+' | head -10
```

## I'm Feeling Lucky

```bash
open "https://www.google.com/search?q=your+query&btnI=1"
```
