---
name: things-mac
description: Create and manage tasks in Things 3 for Mac using URL schemes and AppleScript.
metadata: {"openclaw":{"emoji":"✓","os":["darwin"],"requires":{}}}
---

# Things (Mac)

Manage Things 3 tasks from the command line on macOS.

## Add a Task

```bash
open "things:///add?title=Buy+groceries&notes=Milk,+eggs,+bread&when=today"
```

## Add with Tags and List

```bash
open "things:///add?title=Review+PR&list=Work&tags=urgent,code&when=today"
```

## Add a Project

```bash
open "things:///add-project?title=Website+Redesign&notes=Q1+project&area=Work"
```

## Show Tasks

```bash
open "things:///show?id=today"
open "things:///show?id=upcoming"
open "things:///show?id=anytime"
```

## Search

```bash
open "things:///search?query=groceries"
```
