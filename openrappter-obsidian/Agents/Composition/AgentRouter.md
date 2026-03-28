# AgentRouter

Rule-based message routing to agents by sender, channel, group, or pattern. Priority-sorted rules with session key isolation.

## Usage

```typescript
import { AgentRouter } from './agents/router.js';

const router = new AgentRouter();
router.setDefaultAgent(generalAgent);

router.addRule({
  id: 'dev-shell',
  priority: 10,
  conditions: { channel: 'slack', pattern: /^!(shell|run|exec)/ },
  agentId: 'ShellAgent'
});

router.addRule({
  id: 'support-memory',
  priority: 5,
  conditions: { sender: 'support-team' },
  agentId: 'MemoryAgent'
});

const agent = router.route({ channel: 'slack', message: '!shell ls', sender: 'dev' });
// Returns 'ShellAgent' (priority 10 matches)
```

## Rule Conditions

| Condition | Description |
|-----------|-------------|
| `sender` | Exact sender match |
| `channel` | Channel name match |
| `group` | Group/room match |
| `pattern` | Regex against message content |

Rules sorted by priority (higher wins). First match routes.

## Session Key Isolation

```typescript
router.setSessionKeyFormat('{channel}:{sender}');
// Different channel+sender combos get isolated sessions
```

## Files
- `typescript/src/agents/router.ts`
- `python/openrappter/agents/router.py`

## Related
- [[Agent Composition]]
- [[BroadcastManager]]
- [[Channel Architecture]]

---

#agents #composition #routing
