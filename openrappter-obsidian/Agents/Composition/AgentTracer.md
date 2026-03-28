# AgentTracer

Span-based tracing system for agent execution. Tracks start/end/duration/inputs/outputs across chains, graphs, and sub-agent calls.

## Usage

```typescript
import { globalTracer } from './agents/tracer.js';

// Start a span
const { span, context } = globalTracer.startSpan('ShellAgent', 'execute', undefined, { action: 'bash' });

// ... run agent ...

// End span with results
globalTracer.endSpan(span.id, { status: 'success', outputs: { exitCode: 0 } });

// Child spans link to parents via context propagation
const { span: child } = globalTracer.startSpan('MemoryAgent', 'execute', context);
```

## Key Types

| Type | Fields |
|------|--------|
| `TraceSpan` | `id`, `parentId`, `traceId`, `agentName`, `operation`, `startTime`, `endTime`, `durationMs`, `status`, `inputs?`, `outputs?`, `dataSlush?`, `error?`, `tags?` |
| `TraceContext` | `traceId`, `spanId`, `baggage?` — propagated through chains/graphs |

## Querying

```typescript
globalTracer.getTrace(traceId);           // All spans for a trace
globalTracer.getActiveSpans();            // Currently running
globalTracer.getCompletedSpans(limit);    // Finished spans
globalTracer.toJSON();                    // Serializable summary
```

## Options

```typescript
const tracer = createTracer({
  maxSpans: 1000,        // Span buffer size
  recordIO: true,        // Capture inputs/outputs
  onSpanComplete: (span) => dashboard.addTrace(span)  // Callback
});
```

## Files
- `typescript/src/agents/tracer.ts`
- `python/openrappter/agents/tracer.py`
- Tests: `typescript/src/__tests__/parity/agent-tracer.test.ts` (24 tests)

## Related
- [[Agent Composition]]
- [[Gateway Server]] — Dashboard displays traces
- [[Showcase Demos]] — Demo #6 "Living Dashboard" uses tracer

---

#agents #composition #observability
