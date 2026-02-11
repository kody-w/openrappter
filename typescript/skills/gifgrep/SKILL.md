---
name: gifgrep
description: Search and retrieve GIFs from Giphy and Tenor APIs.
metadata: {"openclaw":{"emoji":"🎞️","requires":{"env":["GIPHY_API_KEY"]},"primaryEnv":"GIPHY_API_KEY"}}
---

# GifGrep

Search for GIFs using Giphy and Tenor.

## Search Giphy

```bash
curl -s "https://api.giphy.com/v1/gifs/search?api_key=$GIPHY_API_KEY&q=funny+cat&limit=5" | jq '.data[].url'
```

## Trending GIFs

```bash
curl -s "https://api.giphy.com/v1/gifs/trending?api_key=$GIPHY_API_KEY&limit=10" | jq '.data[].url'
```

## Random GIF

```bash
curl -s "https://api.giphy.com/v1/gifs/random?api_key=$GIPHY_API_KEY&tag=celebration" | jq '.data.url'
```
