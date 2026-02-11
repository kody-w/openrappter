---
name: blogwatcher
description: Monitor RSS/Atom feeds and blogs for new posts. Fetches and summarizes latest entries.
metadata: {"openclaw":{"emoji":"📰","requires":{"bins":["curl"]}}}
---

# Blog Watcher

Monitor RSS/Atom feeds for new posts.

## Fetch a Feed

```bash
curl -s "https://example.com/feed.xml" | head -100
```

## Parse RSS with xmllint

```bash
curl -s "https://example.com/feed.xml" | xmllint --xpath '//item/title/text()' -
```

## Watch Multiple Feeds

Store feed URLs in a file and iterate:

```bash
while IFS= read -r url; do
  echo "=== $url ==="
  curl -s "$url" | xmllint --xpath '//item[position()<=3]/title/text()' - 2>/dev/null
done < feeds.txt
```
