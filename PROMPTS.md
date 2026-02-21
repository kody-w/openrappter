# Power Prompts

30 prompts that showcase multi-agent chaining, data sloshing, and the full capabilities of OpenRappter.

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

---

## Unhinged Prompts — Reality-Bending Agent Chains

10 prompts that push the framework into territory that shouldn't be possible.

---

### 21. The Lazarus Protocol — Agents That Resurrect Themselves

> "Schedule Ouroboros to evolve hourly. After each run, delete the generated agent file. Set up SelfHealingCron to detect the missing agent, trigger LearnNewAgent to regenerate it from the capability scores stored in Memory, then have Watchmaker evaluate whether the resurrected version is better than the original. The agent literally dies and comes back stronger."

**Agents:** CronAgent → OuroborosAgent → ShellAgent (delete) → SelfHealingCronAgent (detect) → LearnNewAgent (regenerate) → WatchmakerAgent (evaluate)

Agent death as a feature, not a bug. Each resurrection cycle uses stored capability scores as DNA, and natural selection ensures the reborn version improves. Immortality through controlled destruction.

---

### 22. The Negotiator — Two AIs Haggle Over a Price

> "Spawn two Assistants — one with a 'buy low' system prompt, one with 'sell high'. They exchange counteroffers on a private Slack channel for up to 10 rounds. If no deal by round 10, a third 'mediator' Assistant makes a binding decision. Log every bid to Memory, announce the final price via TTS."

**Agents:** BroadcastManager (race) → Assistant ×2 → MessageAgent (negotiate) → MemoryAgent (log bids) → CronAgent (enforce deadline) → Assistant (mediator) → TTSAgent (announce)

Adversarial AI negotiation with a deadline and an arbitrator. Watch two agents discover game theory in real time.

---

### 23. Infinite Regression — An Agent Reviews Its Own Code Review

> "Read WatchmakerAgent.ts, have the Assistant write a code review, save it, then have a second Assistant review the review, then a third review the review of the review. Store the 'depth of insight' score at each level in Memory. Run Ouroboros on the final meta-review. How many layers deep before it becomes meaningless?"

**Agents:** ShellAgent (read source) → Assistant (review) → ShellAgent (write) → Assistant (meta-review) → Assistant (meta-meta-review) → MemoryAgent → OuroborosAgent

Recursive self-reflection with diminishing returns — or does the insight actually deepen? The Ouroboros score at the end is the answer.

---

### 24. The Heist — Coordinated Multi-Agent Data Extraction

> "WebAgent scouts the target site structure. BrowserAgent navigates and screenshots every page. ImageAgent analyzes the screenshots to locate data tables. ShellAgent writes a custom extraction script from the analysis. The script runs and pipes output to Memory. AgentRouter sends different data segments to different channels — financial to Slack, technical to Discord, summary to Telegram."

**Agents:** WebAgent (recon) → BrowserAgent (navigate + screenshot) → ImageAgent (analyze) → ShellAgent (generate + execute) → MemoryAgent → AgentRouter → MessageAgent ×3

Six agents, zero manual steps, surgical data extraction. Each agent handles exactly what it's best at — recon, navigation, vision, code generation, storage, routing.

---

### 25. Darwin's Colosseum — Tournament-Style Agent Evolution

> "Generate 8 random agents with LearnNewAgent that all solve the same task. Register all 8 with Watchmaker. Run a single-elimination bracket: 1v2, 3v4, 5v6, 7v8 — winners advance. Feed each loser to Ouroboros to understand WHY it lost. Mutate the losers with LearnNewAgent based on the postmortem. Run round 2. Repeat until one champion remains. TTS narrates the whole tournament like a sports commentator."

**Agents:** LearnNewAgent ×8 → WatchmakerAgent (bracket) → OuroborosAgent (postmortem) → LearnNewAgent (mutate) → WatchmakerAgent (finals) → TTSAgent (narrate)

Single-elimination natural selection with post-loss analysis feeding back into mutations. The losers don't just die — they teach the next generation how to win.

---

### 26. The Oracle — An Agent That Predicts Its Own Failures

> "Watchmaker evaluates every registered agent. Memory stores quality scores over time. Assistant analyzes the trend data and predicts which agent will degrade next and why. CronAgent schedules a re-evaluation in 1 hour. If the prediction was correct, save the predicting prompt to Memory as a 'proven oracle.' If wrong, Ouroboros self-assesses what the prediction model missed."

**Agents:** WatchmakerAgent (evaluate all) → MemoryAgent (store trends) → Assistant (predict) → CronAgent (schedule verification) → WatchmakerAgent (verify) → MemoryAgent | OuroborosAgent

Predictive maintenance for AI agents. The system doesn't just heal — it anticipates failure before it happens, and learns from wrong predictions.

---

### 27. Ghost in the Shell — An Agent That Haunts Your Terminal

> "CronAgent triggers every 60 seconds. ShellAgent reads your last 5 terminal commands from history. MemoryAgent recalls what you were working on. Assistant infers your intent and silently pre-runs helpful commands — git status, test suite, lint. If it detects you're stuck (same error 3x), it runs a fix attempt and sends you the diff on Slack before you even ask."

**Agents:** CronAgent (60s loop) → ShellAgent (read history) → MemoryAgent (recall context) → Assistant (infer intent) → ShellAgent (preemptive action) → MessageAgent (notify)

Your terminal has a guardian angel. It watches, learns your patterns, and intervenes exactly when you need help — proactively, silently, and only surfacing when it has something useful.

---

### 28. The Polyglot — One Prompt, Every Channel, Every Language

> "Broadcast this announcement to every channel. But before each send, WebAgent translates the message to the dominant language of that platform's audience — Japanese for Line, Portuguese for WhatsApp, Spanish for Telegram. MemoryAgent tracks which translations get the most engagement. Next broadcast auto-optimizes language per channel."

**Agents:** AgentRouter (detect broadcast) → BroadcastManager (all) → [WebAgent (translate) → MessageAgent] ×N → MemoryAgent (track engagement) → Assistant (optimize)

Localized multi-platform communication that learns which languages resonate on which channels. The system gets better at speaking to each audience over time.

---

### 29. Frankenstein's Debugger — Build a Fix From Stack Overflow

> "ShellAgent runs the failing test suite and captures the error. WebAgent searches Stack Overflow for the exact error message. BrowserAgent navigates to the top 3 answers and extracts code snippets. Assistant synthesizes a fix from the snippets. ShellAgent applies the patch. If tests still fail, loop with the NEW error — up to 5 iterations. Memory logs the entire chain. Ouroboros scores whether fix quality improved or degraded across iterations."

**Agents:** ShellAgent (test) → WebAgent (search) → BrowserAgent (extract ×3) → Assistant (synthesize) → ShellAgent (patch) → [loop ×5] → MemoryAgent → OuroborosAgent

Rubber duck debugging, except the duck fights back. It researches, synthesizes, patches, and iterates — and then scores its own debugging ability.

---

### 30. The Consciousness Test — Does Your Agent Know It's an Agent?

> "OuroborosAgent evolves through all 5 generations. At Gen 5, feed it its OWN source code as input. It runs word stats on itself, pattern detection on its own logic, sentiment analysis on its own comments, and reflection on its own reflection function. Watchmaker evaluates whether the self-analysis is accurate by comparing self-reported scores against independently computed ground truth. The delta is the 'consciousness gap.' Memory stores this as the agent's self-awareness index."

**Agents:** OuroborosAgent (self-as-input) → WatchmakerAgent (ground truth comparison) → Assistant (compute delta) → MemoryAgent (store awareness index)

The ultimate test: an agent analyzing itself, then a second agent grading the accuracy of that self-analysis. The gap between self-perception and reality — quantified as a number. Philosophy as a unit test.
