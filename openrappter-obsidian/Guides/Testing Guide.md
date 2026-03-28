# Testing Guide

## TypeScript (Vitest)

```bash
cd typescript

# Run all tests
npm test                    # or: npx vitest run

# Watch mode
npm run test:watch

# Single file
npx vitest run src/__tests__/parity/agent-graph.test.ts

# Pattern match
npx vitest run src/__tests__/parity/showcase-*.test.ts

# With coverage
npx vitest run --coverage
```

### Test Organization

| Directory | Content |
|-----------|---------|
| `src/__tests__/parity/` | Parity tests (same behavior in TS + Python) |
| `src/__tests__/parity/showcase-*.test.ts` | 20 showcase demo tests |

### Key Test Files

| Test | Tests | What |
|------|-------|------|
| `agent-graph.test.ts` | 19 | DAG executor |
| `agent-tracer.test.ts` | 24 | Span-based tracing |
| `mcp-server.test.ts` | 18 | MCP protocol |
| `dashboard-api.test.ts` | 21 | REST API |
| `showcase-ui.test.ts` | 21 | Showcase dashboard |
| `learn-new-agent.test.ts` | 61 | Agent generation |
| `ouroboros.test.ts` | varies | Capability scoring |

### Testing Conventions

- All tests are deterministic — mock agents, no LLM calls
- Vitest globals enabled (`describe`, `it`, `expect` without imports)
- Node environment (not jsdom)
- Helper agents defined inline in test files

## Python (pytest)

```bash
cd python

# Install dev dependencies
pip install -e ".[dev]"

# Run all tests
pytest

# Single file
pytest tests/test_my_agent.py

# With coverage
pytest --cov=openrappter
```

### Python Test Organization

| Directory | Content |
|-----------|---------|
| `tests/` | All Python tests |

## Writing Tests

For agents, mock the `perform()` dependencies, not the agent itself:

```typescript
// Good: test real agent with mock data
const agent = new MyAgent();
const result = await agent.execute({ query: 'test input' });
expect(JSON.parse(result).status).toBe('success');

// For injectable agents (GitAgent, SelfHealingCronAgent):
const agent = new GitAgent((cmd) => Promise.resolve('mock output'));
```

## Related
- [[Getting Started]]
- [[Creating an Agent]]
- [[Showcase Demos]]

---

#guides #testing
