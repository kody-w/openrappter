# Agent Index

Complete catalog of all agents in both runtimes.

## Core Agents

| Agent | TS | PY | Description |
|-------|----|----|-------------|
| [[BasicAgent]] | `BasicAgent.ts` | `basic_agent.py` | Abstract base with [[Data Sloshing]] |
| [[ShellAgent]] | `ShellAgent.ts` | `shell_agent.py` | Bash, file read/write/list |
| [[MemoryAgent]] | `MemoryAgent.ts` | `manage_memory_agent.py` | Persistent memory store/recall |
| [[LearnNewAgent]] | `LearnNewAgent.ts` | `learn_new_agent.py` | Meta-agent: creates agents from NL |
| [[WebAgent]] | `WebAgent.ts` | `web_agent.py` | HTTP fetch + web search |
| [[GitAgent]] | `GitAgent.ts` | `git_agent.py` | Git operations |
| [[CodeReviewAgent]] | `CodeReviewAgent.ts` | `code_review_agent.py` | Heuristic code review |

## Specialized Agents (TypeScript)

| Agent | Description |
|-------|-------------|
| [[OuroborosAgent]] | Self-evolving with lineage tracking |
| [[WatchmakerAgent]] | A/B testing + natural selection |
| [[SelfHealingCronAgent]] | Health check loop: detect, repair, notify |
| [[PipelineAgent]] | Declarative multi-agent pipelines |
| Assistant | LLM-powered orchestration |
| MessageAgent | Send to channels |
| BrowserAgent | Puppeteer automation |
| ImageAgent | Image generation |
| TTSAgent | Text-to-speech |
| SessionsAgent | Multi-turn sessions |
| CronAgent | Job scheduling |
| DailyTipAgent | 30-day onboarding |
| DreamAgent | Memory consolidation |
| HackerNewsAgent | HN stories |
| PongAgent | Health check |

## Composition Patterns

| Pattern | Description |
|---------|-------------|
| [[AgentChain]] | Sequential pipeline with slush forwarding |
| [[AgentGraph]] | DAG executor with parallel nodes |
| [[AgentRouter]] | Rule-based message routing |
| [[BroadcastManager]] | Multi-agent broadcast (all/race/fallback) |
| SubAgentManager | Nested invocation with depth limits |
| [[AgentTracer]] | Span-based execution tracing |

See [[Agent Composition]] for details.

---

#agents #index
