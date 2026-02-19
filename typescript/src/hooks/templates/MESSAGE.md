---
id: message-default
name: Message Hook
phase: message.incoming
priority: 100
timeout: 5000
---

# Message Hook

This hook runs for every incoming message before it reaches the agent.

Use it to:
- Filter or transform messages
- Rate-limit specific users or channels
- Enrich messages with user preferences or session context
- Log message events for audit purposes
- Block unwanted content (return `{ bail: true }` to drop the message)

## Handler

The `context.data` object for `message.incoming` typically contains:

| Key           | Type   | Description                         |
|---------------|--------|-------------------------------------|
| `message`     | string | The raw message content             |
| `userId`      | string | Sender identifier                   |
| `channelId`   | string | Channel the message arrived on      |
| `sessionId`   | string | Active session identifier           |

```typescript
// Example message.incoming hook — customize or delete this template
const { message, userId, channelId } = context.data;

console.log(`[message.incoming] ${channelId} / ${userId}: "${message}"`);

// Bail on empty messages
if (!message || String(message).trim() === '') {
  console.warn('[message.incoming] Dropping empty message');
  return { bail: true };
}

// Add enriched context for downstream hooks or the agent
return {
  data: {
    ...context.data,
    processedAt: context.timestamp.toISOString(),
    wordCount: String(message).split(/\s+/).length,
  },
};
```
