---
name: bear-notes
description: Search, read, and create notes in Bear using x-callback-url on macOS.
metadata: {"openclaw":{"emoji":"🐻","os":["darwin"],"requires":{}}}
---

# Bear Notes

Interact with Bear note-taking app via x-callback-url on macOS.

## Open a Note

```bash
open "bear://x-callback-url/open-note?title=My%20Note"
```

## Create a Note

```bash
open "bear://x-callback-url/create?title=New%20Note&text=Content%20here&tags=tag1,tag2"
```

## Search Notes

```bash
open "bear://x-callback-url/search?term=search%20query"
```

## Add to Existing Note

```bash
open "bear://x-callback-url/add-text?title=My%20Note&text=Appended%20content&mode=append"
```
