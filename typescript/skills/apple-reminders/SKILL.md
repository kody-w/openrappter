---
name: apple-reminders
description: Create, list, and manage Apple Reminders using osascript/JXA on macOS.
metadata: {"openclaw":{"emoji":"✅","os":["darwin"],"requires":{}}}
---

# Apple Reminders

Manage Apple Reminders via JXA on macOS.

## List Reminders

```bash
osascript -l JavaScript -e '
  const app = Application("Reminders");
  app.defaultList().reminders().map(r => ({
    name: r.name(),
    completed: r.completed(),
    dueDate: r.dueDate()
  }));
'
```

## Create a Reminder

```bash
osascript -l JavaScript -e '
  const app = Application("Reminders");
  const list = app.defaultList();
  app.make({new: "reminder", at: list, withProperties: {name: "Buy groceries", body: "Milk, eggs, bread"}});
'
```

## Complete a Reminder

```bash
osascript -l JavaScript -e '
  const app = Application("Reminders");
  const r = app.defaultList().reminders.whose({name: "Buy groceries"})()[0];
  r.completed = true;
'
```
