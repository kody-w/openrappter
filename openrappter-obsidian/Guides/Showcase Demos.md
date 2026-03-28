# Showcase Demos

20 advanced agent orchestration patterns with runnable examples and deterministic test suites. All demos use mock agents — no LLM calls required.

## Running Demos

```bash
cd typescript

# Run all showcase tests
npx vitest run src/__tests__/parity/showcase-*.test.ts

# Run a specific demo test
npx vitest run src/__tests__/parity/showcase-architect.test.ts

# Run via gateway RPC
# showcase.list, showcase.run({ demoId }), showcase.runall
```

## Demo Catalog

### Competition & Evolution
| # | Demo | Pattern | Key Concepts |
|---|------|---------|--------------|
| 1 | **The Architect** | [[LearnNewAgent]] + [[AgentGraph]] | Runtime agent creation, DAG wiring, multi-upstream slush |
| 5 | **Watchmaker's Tournament** | [[AgentGraph]] parallel | Competing agents, evaluator, ranking, tie handling |
| 20 | **Agent Stock Exchange** | Graph + Broadcast + Router | Emergent marketplace behavior |

### Chains & Pipelines
| # | Demo | Pattern | Key Concepts |
|---|------|---------|--------------|
| 2 | **Ouroboros Accelerator** | [[AgentChain]] | Chain transforms, slush propagation, stopOnError |
| 9 | **Agent Compiler** | [[PipelineAgent]] | Conditional steps, `data_slush` threading |

### Parallel & Broadcast
| # | Demo | Pattern | Key Concepts |
|---|------|---------|--------------|
| 3 | **Swarm Debugger** | [[BroadcastManager]] race | Fastest wins, slush forwarding |
| 4 | **Mirror Test** | [[AgentGraph]] parallel | Parity comparison, confidence delta |
| 8 | **Code Archaeologist** | [[AgentGraph]] fan-out/fan-in | Parallel analysis, synthesis |

### Observability & Meta
| # | Demo | Pattern | Key Concepts |
|---|------|---------|--------------|
| 6 | **Living Dashboard** | Chain → [[AgentTracer]] → Dashboard → [[MCP Server]] | Self-monitoring loop |
| 7 | **Infinite Regression** | SubAgentManager | Depth limits, loop detection, blocklists |
| 10 | **Doppelganger** | Tracer + clone | Trace IO capture, clone comparison |
| 11 | **The Inception Stack** | Recursive meta-creation | 3-level deep agent nesting |

### Core Systems
| # | Demo | Pattern | Key Concepts |
|---|------|---------|--------------|
| 12 | **Data Sloshing Deep Dive** | [[Data Sloshing]] full pipeline | SloshFilter, SloshPrivacy, feedback loop |
| 13 | **Memory Recall** | [[Memory System]] | FTS, chunking, snippets |
| 14 | **Channel Switchboard** | [[Channel Architecture]] | Registry, routing, status |
| 15 | **Config Hotswap** | [[Config System]] | JSON5, validation, env vars, merge |
| 16 | **Persistence Vault** | [[Storage System]] | SQLite adapter, sessions, chunks |

### Resilience & Security
| # | Demo | Pattern | Key Concepts |
|---|------|---------|--------------|
| 17 | **Healing Loop** | [[SelfHealingCronAgent]] | Health check, auto-repair, notify |
| 18 | **Authorization Fortress** | ApprovalManager | Policies, rules, allow/deny, request flows |
| 19 | **Stream Weaver** | StreamManager | Sessions, blocks, deltas, subscribers |

## Files

All paths relative to `typescript/`:
- Examples: `examples/<demo-name>.ts`
- Tests: `src/__tests__/parity/showcase-<demo-name>.test.ts`
- RPC methods: `src/gateway/methods/showcase-methods.ts`
- UI component: `ui/src/components/showcase.ts`

## Related
- [[Agent Composition]]
- [[Agent Index]]
- [[Multi-Agent Patterns]]

---

#guides #showcase
