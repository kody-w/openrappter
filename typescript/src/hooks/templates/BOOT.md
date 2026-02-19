---
id: boot-default
name: Boot Hook
phase: boot
priority: 100
timeout: 10000
---

# Boot Hook

This hook runs once when the openrappter agent system starts up.

Use it to perform initialization tasks such as:
- Validating required environment variables
- Pre-warming connections or caches
- Logging startup state
- Loading external configuration

## Handler

The `context` object has the following shape:

```typescript
interface HookContext {
  phase: 'boot';
  timestamp: Date;
  data: Record<string, unknown>;    // mutable, passed to subsequent hooks
  metadata: Record<string, unknown>; // read-only event metadata
}
```

Replace the code below with your initialization logic.

```typescript
// Example boot hook — customize or delete this template
console.log('[boot] openrappter starting at', context.timestamp.toISOString());

// Validate required environment variables
const required = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter(
  (key) => !process.env[key]
);
if (required.length > 0) {
  console.warn('[boot] Missing optional env vars:', required.join(', '));
}

// Return data to pass to subsequent boot hooks
return {
  data: {
    bootTime: context.timestamp.toISOString(),
    pid: process.pid,
  },
};
```
