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
