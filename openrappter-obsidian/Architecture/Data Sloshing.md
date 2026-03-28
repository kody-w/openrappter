# Data Sloshing

Data sloshing is openrappter's **implicit context enrichment** system. Before every `perform()` call, the framework automatically gathers signals and injects them into the agent's context.

## What Gets Sloshed

| Category | Key Signals | Example |
|----------|------------|---------|
| **Temporal** | `time_of_day`, `day_of_week`, `is_weekend`, `quarter`, `fiscal_period`, `urgency` | "Friday evening — casual tone" |
| **Query Signals** | `specificity`, `hints`, `word_count`, `is_question`, `ownership` | "Short question — concise answer" |
| **Memory Echoes** | `message`, `theme`, `relevance` | "User asked about Git yesterday" |
| **Behavioral** | `prefers_brief`, `technical_level` | "Technical user, skip basics" |
| **Orientation** | `confidence`, `approach`, `response_style` | "High confidence — direct answer" |

## How It Works

```
execute(kwargs)
  1. slosh(query)
     - Gather temporal context (clock/calendar)
     - Analyze query signals (NLP heuristics)
     - Search memory echoes (past interactions)
     - Apply behavioral hints (user prefs)
     - Synthesize Orientation (confidence + approach)
  2. Inject all signals into this.context / self.context
  3. perform(kwargs)  <-- agent reads enriched context
```

## Accessing Signals

```typescript
// TypeScript - dot notation with defaults
const timeOfDay = this.getSignal('temporal.time_of_day');
const isQuestion = this.getSignal('query_signals.is_question', false);
```

```python
# Python - same API
time_of_day = self.get_signal('temporal.time_of_day')
is_question = self.get_signal('query_signals.is_question', False)
```

## Advanced Features

- **SloshFilter**: Include/exclude specific signal categories
- **SloshPrivacy**: Redact (delete paths) or obfuscate (hash replacement) sensitive signals
- **SloshDebug**: Capture pipeline stages: post-slosh, post-filter, post-privacy, post-perform
- **Signal Feedback**: Utility scores accumulate; low-value signals auto-suppress at threshold

See showcase demo #12 "Data Sloshing Deep Dive" for runnable examples.

## Related
- [[Data Slush Pipeline]] — Agent-to-agent output forwarding
- [[BasicAgent]] — Base class implementing sloshing
- [[Architecture Overview]]

---

#architecture #data-sloshing
