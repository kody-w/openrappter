# BasicAgent

Abstract base class for all agents. Implements [[Data Sloshing]], context management, and the `execute()` → `perform()` lifecycle.

## Lifecycle

```
execute(kwargs)
  1. slosh(query)           — gather signals
  2. merge upstream_slush   — receive data from previous agent
  3. perform(kwargs)        — YOUR code runs here
  4. extract data_slush     — output for downstream agents
```

## Key Methods

| Method | Description |
|--------|-------------|
| `execute(kwargs)` | Entry point — runs sloshing, then perform() |
| `perform(kwargs)` | **Abstract** — subclasses implement this |
| `slosh(query)` | Gathers implicit context signals |
| `getSignal(key, default?)` | Dot-notation: `getSignal('temporal.time_of_day')` |

## Context (after sloshing)

```typescript
this.context = {
  temporal: { time_of_day, day_of_week, is_weekend, ... },
  query_signals: { specificity, is_question, ... },
  memory_echoes: [{ message, theme, relevance }],
  behavioral: { prefers_brief, technical_level },
  orientation: { confidence, approach },
  upstream_slush: { ... }
}
```

## Files
- `typescript/src/agents/BasicAgent.ts`
- `python/openrappter/agents/basic_agent.py`

## Related
- [[Data Sloshing]] | [[Data Slush Pipeline]] | [[Single File Agent Pattern]] | [[Agent Index]]

---

#agents #core
