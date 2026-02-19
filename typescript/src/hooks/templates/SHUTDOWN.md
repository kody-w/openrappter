---
id: shutdown-default
name: Shutdown Hook
phase: shutdown
priority: 100
timeout: 15000
---

# Shutdown Hook

This hook runs when the openrappter agent system is shutting down.

Use it to perform cleanup tasks such as:
- Flushing in-memory buffers to disk
- Closing database connections
- Notifying external services
- Writing a final audit log entry
- Saving session state

## Handler

The `context` object for `shutdown` includes metadata about why the
shutdown was triggered (if available):

| Key          | Type   | Description                                      |
|--------------|--------|--------------------------------------------------|
| `signal`     | string | OS signal that triggered shutdown (e.g. SIGTERM) |
| `reason`     | string | Human-readable shutdown reason                   |
| `uptime`     | number | Process uptime in seconds                        |

```typescript
// Example shutdown hook — customize or delete this template
const { signal, reason, uptime } = context.metadata;

console.log(
  `[shutdown] Shutting down — signal: ${signal ?? 'none'}, reason: ${reason ?? 'unknown'}, ` +
  `uptime: ${typeof uptime === 'number' ? `${uptime.toFixed(1)}s` : 'unknown'}`
);

// Simulate async cleanup (replace with real teardown logic)
await new Promise<void>((resolve) => setTimeout(resolve, 50));

console.log('[shutdown] Cleanup complete.');

return {
  data: {
    shutdownAt: context.timestamp.toISOString(),
  },
};
```
