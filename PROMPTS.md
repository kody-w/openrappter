# Power Prompts

10 prompts that showcase multi-agent chaining, data sloshing, and the full capabilities of OpenRappter.

---

### 1. Real-Time Product Mention Monitoring

> "Monitor Hacker News for any post mentioning our product, summarize it, and send it to Slack every hour"

**Agents:** CronAgent → HackerNewsAgent → WebAgent → MessageAgent

Data slush flows HN results into summarization context into Slack notification. Fully automated competitive intelligence.

---

### 2. Zero-Code Agent Generation

> "Learn a new agent that scrapes competitor pricing from these 3 URLs, diffs against yesterday's prices, and alerts me on Telegram if anything changed more than 10%"

**Agents:** LearnNewAgent → CronAgent → WebAgent → MessageAgent

LearnNewAgent hot-generates a custom agent at runtime, then CronAgent schedules it. Zero code written by a human.

---

### 3. Self-Evaluating AI

> "Run Ouroboros, then for every capability that scored below 50%, search the web for improvement strategies and write a self-improvement plan to memory"

**Agents:** OuroborosAgent → WebAgent → MemoryAgent

The system evaluates itself, researches how to get better, and remembers the plan.

---

### 4. Parallel Multi-Platform Broadcast

> "Broadcast this deploy announcement to Slack, Discord, and Telegram simultaneously — if any channel fails, retry it, but don't block the others"

**Agents:** BroadcastManager (`all` mode) → MessageAgent ×3

One prompt, three platforms, parallel delivery with per-channel error handling.

---

### 5. Automated Visual QA

> "Navigate to our staging app, screenshot the dashboard, analyze the image for any visual regressions, and file the results as a memory entry"

**Agents:** BrowserAgent → ImageAgent → MemoryAgent

Automated visual regression detection with no external tools.

---

### 6. Full Incident Response Loop

> "Set up a self-healing check on our API, and if it goes down, restart the Docker container, re-check, screenshot the status page, and send the screenshot to Slack with a summary"

**Agents:** SelfHealingCronAgent → ShellAgent → WebAgent → BrowserAgent → MessageAgent

Detection, remediation, verification, and notification — hands-free.

---

### 7. AI Morning Briefing

> "Every morning at 8am, read my calendar file, check the weather via web search, summarize today's priorities from memory, and speak the briefing aloud"

**Agents:** CronAgent → ShellAgent → WebAgent → MemoryAgent → TTSAgent

A personalized daily briefing assembled from 5 agents and delivered by voice.

---

### 8. Intelligent Message Triage

> "Route all messages from the #support Slack channel to the Shell agent for log lookups, all messages from #general to the Memory agent for knowledge storage, and everything else to the Assistant"

**Agents:** AgentRouter → ShellAgent / MemoryAgent / Assistant

Pattern-based rules doing real-time message triage. Different agents handle different channels automatically.

---

### 9. Research Pipeline

> "Search Hacker News for the top AI papers this week, fetch each link, extract the key findings, store them in memory tagged by topic, then give me a spoken TTS summary of the top 3"

**Agents:** HackerNewsAgent → WebAgent → MemoryAgent → TTSAgent

A pipeline that reads, comprehends, remembers, and narrates.

---

### 10. AI That Builds and Schedules AI Agents

> "Learn a new agent called 'DailyDigest' that pulls my recent memories, checks my cron job statuses, fetches top HN stories, and composes a personalized daily email — then schedule it for 7am every day"

**Agents:** LearnNewAgent → CronAgent (scheduling the newly created agent)

The system creates a brand new agent from a natural language description, wiring together MemoryAgent + CronAgent + HackerNewsAgent + MessageAgent internally. Then CronAgent schedules the agent it just invented. An AI that builds AI agents and puts them on autopilot.

---

## Advanced Prompts — Self-Improving Systems

10 prompts that push beyond task execution into agents that improve themselves.

---

### 11. Agent Debate Arena

> "Have three agents independently analyze whether we should migrate to PostgreSQL — WebAgent researches benchmarks, ShellAgent profiles our current SQLite, MemoryAgent recalls past scaling issues — then vote on a recommendation"

**Agents:** BroadcastManager (`all` mode) → WebAgent + ShellAgent + MemoryAgent → consensus

Broadcasts a question, collects independent analyses, and synthesizes a consensus. Agents literally argue with each other.

---

### 12. Chaos Monkey Mode

> "Run chaos engineering on our self-healing setup — randomly kill the API every 2-5 minutes and grade how fast the SelfHealingCronAgent detects and recovers, then report a resilience score"

**Agents:** CronAgent → ShellAgent (inject failure) → SelfHealingCronAgent (detect + recover) → MemoryAgent (score)

Your infrastructure tests *itself*. Inject failures, measure recovery, score resilience.

---

### 13. Agent That Writes Agents That Write Agents

> "Learn an agent called 'AgentFactory' that accepts a natural language description and uses LearnNewAgent to generate it, then tests it with Ouroboros, and iterates until it scores above 80%"

**Agents:** LearnNewAgent → OuroborosAgent → LearnNewAgent (iterate)

Meta-meta-programming. Generate an agent, evaluate it, regenerate until quality passes. Recursive self-improvement.

---

### 14. Dream Mode — Offline Memory Consolidation

> "Enter dream mode: review all memories from the past week, find contradictions, merge duplicates, extract patterns, rank by relevance, and prune anything stale"

**Agents:** CronAgent (off-hours trigger) → MemoryAgent (read all) → MemoryAgent (consolidate + prune)

Triggered during idle time, the system reviews its own knowledge, detects contradictions, merges duplicates, and wakes up smarter. Like biological sleep for AI.

---

### 15. Live A/B Testing Pipeline

> "A/B test two different restart strategies for the API — strategy A restarts the container, strategy B scales up a new instance — run both for a week and tell me which had better uptime"

**Agents:** SelfHealingCronAgent ×2 (forked configs) → MemoryAgent (track stats) → MessageAgent (report winner)

Fork SelfHealingCronAgent configs with different restart commands, track history for both, and statistically compare recovery times.

---

### 16. Reverse-Engineer Any API

> "Probe this undocumented API at https://example.com/api — discover all endpoints by fuzzing common REST patterns, document the request/response shapes, and generate a TypeScript client SDK"

**Agents:** WebAgent (systematic probing) → MemoryAgent (accumulate findings) → ShellAgent (write SDK to disk)

Crawl APIs like a spider crawls websites. Systematic endpoint discovery, shape documentation, and code generation.

---

### 17. Skill Forge — Generate, Publish, Use

> "Create a ClawHub skill that monitors RSS feeds, publish it to the skill registry, install it, then schedule it to check my favorite blogs every morning"

**Agents:** LearnNewAgent → ClawHubClient (publish) → ClawHubClient (install) → CronAgent (schedule)

The framework extends *itself* at runtime. Generate a skill, publish it, and put it to work — all from one prompt.

---

### 18. Time-Travel Debugging

> "Replay the last 5 agent chain executions from memory, show me where data_slush was lost between agents, and suggest which agent dropped context"

**Agents:** MemoryAgent (read breadcrumbs + data_slush) → analysis → MessageAgent (report)

Reconstruct the execution graph from stored breadcrumbs and data slush chains, then identify where signal degradation happened. Debug agent pipelines like you debug code.

---

### 19. Swarm Intelligence — Distributed Problem Solving

> "Split this 500-line error log into 10 chunks, have 10 ShellAgent instances grep each chunk in parallel for error patterns, merge the findings, and rank the top 5 root causes"

**Agents:** ShellAgent (split) → BroadcastManager (`all` mode) → ShellAgent ×10 (parallel grep) → merge + rank

MapReduce for agent orchestration. Fan out work across parallel agents, collect results, reduce to insights.

---

### 20. The Watchmaker — Self-Evolving Agent Ecosystem

> "Run a weekly evolution cycle: Ouroboros scores all agents, LearnNewAgent generates improved versions of the lowest scorers, A/B test old vs new for 48 hours, and if the new version wins, hot-swap it into production"

**Agents:** CronAgent → OuroborosAgent → LearnNewAgent → SelfHealingCronAgent (A/B test) → ShellAgent (hot-swap)

The endgame. Your agent ecosystem evolves through natural selection. Score, regenerate, test, promote. Darwin for software.
