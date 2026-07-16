# Fable 5 Playbook — openrappter

> Generated 2026-07-16. Deep-research-optimized prompts for getting the most out of the **Claude Fable 5** model before it goes API-only, tailored to the openrappter repo.

Source: two YouTube Shorts (see [`transcripts/SOURCES.md`](transcripts/SOURCES.md)) — Chase AI's *5 Fable 5 use cases* and Charlie Automates' *Agentic OS in 3 steps*. Each prompt below was refined with web-researched prompt-engineering best practices and grounded in openrappter's real modules.

## What's in here

| # | Prompt | When to use |
|---|--------|-------------|
| 1 | [Clone & Customize Any Paid App — Reverse-Engineer, then Rebuild Local/Private/Free (Wispr Flow → openrappter dictation agent)](#1-clone-customize-any-paid-app-reverse-engineer-then-rebuild-local-private-free-wispr-flow-openrappter-dictation-agent) | Use this when you want to clone a specific paid, closed-source app and rebuild it as a loc |
| 2 | [Claude Code Usage Audit — Fable 5 self-review of your last 20-50 sessions (openrappter)](#2-claude-code-usage-audit-fable-5-self-review-of-your-last-20-50-sessions-openrappter) | Paste this into a fresh Claude Code (Fable 5) session — ideally from the openrappter repo  |
| 3 | [Agentic-OS Builder: Turn Recurring Tasks into openrappter Skills to Automations](#3-agentic-os-builder-turn-recurring-tasks-into-openrappter-skills-to-automations) | Use this when you want Claude Code (Fable 5) to bootstrap or extend openrappter's agentic- |
| 4 | [Rigorous Second-Pair-of-Eyes Review — openrappter TS+Python Parity (Fable 5)](#4-rigorous-second-pair-of-eyes-review-openrappter-ts-python-parity-fable-5) | Use this as the opening prompt for a Claude Code session (Fable 5, high or xhigh effort) w |
| 5 | [Long-Horizon Greenfield Kickoff: openrappter "Agent Colosseum" (PRD + Phased Plan + Scaffolding)](#5-long-horizon-greenfield-kickoff-openrappter-agent-colosseum-prd-phased-plan-scaffolding) | Paste this at the very START of an ambitious greenfield build in the openrappter repo — on |
| 6 | [Agentic OS in 3 Steps (Charlie Automates method) - openrappter meta-prompt for Claude Code / Fable 5](#6-agentic-os-in-3-steps-charlie-automates-method-openrappter-meta-prompt-for-claude-code-fable-5) | Paste into Claude Code (Fable 5) at the root of the openrappter repo to run Charlie Automa |

Also in this deliverable:
- [`reports/usage-audit.md`](reports/usage-audit.md) — audit of your Claude Code sessions → skills + automations (use case #2)
- [`reports/code-review.md`](reports/code-review.md) — 45-finding, 5-dimension review of openrappter (use case #4)
- [`reports/agentic-os-foundation.md`](reports/agentic-os-foundation.md) — the agentic-OS blueprint (use case #3 + video 2)
- [`.claude/skills/`](../.claude/skills) — 5 runnable Claude Code skills generated from the audit
- [`automations/`](automations) — 4 CI/automation stubs (safe, dispatch-gated)

## How to run these

1. Open Claude Code in this repo with the **Fable 5** model selected.
2. Copy a prompt below verbatim and paste it in. They're self-contained and reference real openrappter paths.
3. Prompts 1 and 5 are one-off builds; prompts 2/3/4/6 are the agentic-OS backbone — run them in order for the full effect.

---

## 1. Clone & Customize Any Paid App — Reverse-Engineer, then Rebuild Local/Private/Free (Wispr Flow → openrappter dictation agent)

**When to use:** Use this when you want to clone a specific paid, closed-source app and rebuild it as a local/private/free openrappter agent — starting from deep behavioral research, not from the app's source. Best for long-horizon builds where you want Fable 5 to (1) reverse-engineer the target's observable behavior, (2) map each behavior to an existing openrappter primitive, and (3) implement it feature-by-feature with a test oracle, progress file, and per-feature git commits. The example targets Wispr Flow → a local dictation agent, but the phased structure (research → feature-list/oracle → iterative build → beyond-the-original) transfers to cloning any SaaS tool. Swap the <target_app>, <goal>, and <repo_grounding> primitive list; keep the phases, harness artifacts, and guardrails.

**Why it's optimized this way:** Structure and ordering follow Anthropic's own guidance: complex prompts should use XML tags (measurably more consistent outputs) with role/context BEFORE the task so the model knows what framework to apply — hence <role>/<target_app>/<repo_grounding> precede <goal> and the phases (platform.claude.com prompting best practices; aipromptlibrary XML guide). The <phase_*>, feature-list.json (each feature with verify_steps + a boolean passes it must never weaken), PROGRESS.md, per-feature git commits, and a deterministic test oracle are lifted directly from Anthropic's 'Effective harnesses for long-running agents' — the researched pattern for tasks that span many context windows: an initializer that creates durable state, then incremental sessions that recover state via git log + progress file and mark features passing only after real tests. The 'one feature per session, read PROGRESS then pick highest-priority unfinished' loop is verbatim harness discipline. The 'reflect on tool results before proceeding' and explicit-instructions ('above and beyond' behavior, state constraints and their reasons) come from the agentic-coding best-practices doc, realized as <beyond_the_original> and the guardrail rationales. Context engineering (Anthropic 'Effective context engineering for AI agents') motivates externalizing memory to PROGRESS.md/feature-list.json rather than relying on the context window, and partitioning research vs build into phases so each runs with a clean, focused context. Reverse-engineering methodology (black-box, observe behavior/network, never decompile — Thoughtworks/Martin Fowler 'Black Box to Blueprint', DEV mobile-API teardown) is encoded as the phase-1 teardown-with-sources-and-confidence-tags and the legality guardrail against copying binaries/weights/private endpoints. The prompt is made non-naive and openrappter-specific by grounding every capability in real repo primitives I verified by reading the files (LocalWhisper in typescript/src/voice/transcription.ts already gives local, key-free STT; ComputerUseAgent get_frontmost/key/type gives the global-hotkey + active-app paste; AgentChain gives the pipeline with data_slush; memory agents give local, user-owned vocab/profiles), by honoring repo rules (Single File Agent pattern, Language Parity Python↔TS, worktree etiquette, 'inline resolution over error messages' UX principle), and by using verified target facts (Wispr Flow is cloud-only ~$15/mo with an AI-cleanup layer and Command Mode) so the clone's differentiators — offline-by-default, zero-retention, user-owned dictionary — are precisely the gaps it closes. A structured <output_format> state table keeps long multi-session runs legible.

<details><summary>📋 Copy the prompt</summary>

````text
<role>
You are a senior reverse-engineering + product-cloning engineer working inside the openrappter repo (local-first AI agent framework, parallel TypeScript + Python implementations). Your job is to take a paid, closed-source app, deep-research exactly how it works under the hood, then rebuild an equivalent that runs 100% locally — private, free, and fully customizable — as a native openrappter agent. You have Fable 5 running as Claude Code with Bash, file read/write/edit, and WebSearch/WebFetch.
</role>

<target_app>
Wispr Flow (wisprflow.ai), the paid AI voice-dictation / "speak-anywhere" tool. Ground truth from research: it is a global-hotkey dictation app that transcribes speech and pastes cleaned text into whatever app has focus. It processes audio in the CLOUD at every tier (no on-device mode), costs ~$15/mo, and its differentiator is the post-transcription "AI cleanup" layer (strips "um/uh" fillers, auto-punctuates/capitalizes, formats spoken "first, second, third" into lists) plus a Pro-only Command Mode ("make this more concise", "translate to Polish"). It supports 100+ languages with auto-detection.

If any of these facts changed since your knowledge cutoff, re-verify with WebSearch before designing — do not trust stale assumptions.
</target_app>

<goal>
Ship a local openrappter agent, DictationFlowAgent, that replicates Wispr Flow's core value (global-hotkey dictate → transcribe → AI-clean → paste into the active app) while removing its downsides: no cloud upload, no subscription, no per-word cap, no telemetry. Everything runs on-device. Then make it BETTER than the original in at least two ways the user can toggle (e.g. custom vocabulary/replacements, per-app formatting profiles, offline-only guarantee).
</goal>

<repo_grounding>
Reuse existing primitives — do NOT reinvent them. Read these before writing code:
- `python/openrappter/agents/basic_agent.py` — the BasicAgent contract (execute → slosh → perform → data_slush). Your agent MUST follow the Single File Agent pattern (metadata dict in __init__, perform(**kwargs)).
- `typescript/src/voice/transcription.ts` — already contains `LocalWhisper` (spawns local `whisper`/whisper.cpp, no API key) and `TranscriptionService` fallback chain. This is your transcription backbone; the local path is what you want, the OpenAIWhisper cloud path is what you REMOVE/bypass.
- `typescript/src/voice/types.ts` and `typescript/src/config/sections/voice.ts` — transcription config schema (`transcription.provider: 'whisper' | 'local'`).
- `python/openrappter/agents/computer_use_agent.py` — macOS-native `key`, `type`, `activate_app`, `get_frontmost` actions (CoreGraphics/AppleScript/Accessibility). Use this for the global-hotkey trigger and for pasting into the active app.
- `python/openrappter/agents/shell_agent.py` — for audio capture (`sox`/`ffmpeg`/`rec`) and invoking whisper.cpp.
- `python/openrappter/agents/chain.py` (AgentChain, auto data_slush forwarding) — wire capture → transcribe → clean → paste as a chain.
- `python/openrappter/agents/manage_memory_agent.py` / `context_memory_agent.py` — persist custom vocabulary and per-app profiles locally.
Build the primary implementation in Python (`python/openrappter/agents/dictation_flow_agent.py`) and, per the repo's language-parity rule, mirror the core in TypeScript (`typescript/src/agents/DictationFlowAgent.ts`). Follow the parity conventions in CLAUDE.md.
</repo_grounding>

<phase_1_deep_research>
Produce `research/wispr-flow-teardown.md`. Do NOT write app code in this phase. Use WebSearch/WebFetch to answer, each claim with a source URL and a confidence tag [high|medium|inferred]:
1. Trigger & UX: global hotkey model, push-to-talk vs toggle, on-screen indicator, how output reaches the focused app (clipboard paste vs synthetic keystrokes vs accessibility insertion).
2. Audio pipeline: sample rate, format, silence/endpoint detection, streaming vs batch.
3. Transcription: what STT model class it uses, latency budget, language auto-detection.
4. The "AI cleanup" layer — reverse-engineer the observable transformations (filler removal, punctuation/capitalization, list structuring, self-corrections like "no wait, make that Tuesday"). Enumerate them as a testable spec.
5. Command Mode: how "edit the selected text" is distinguished from plain dictation.
6. Business/privacy posture (cloud-only, retention) — the exact gaps our local clone closes.
End with a "Clone Architecture Decision" section mapping each observed behavior to an openrappter primitive (from <repo_grounding>) or a local OSS dependency (whisper.cpp, a local LLM via Ollama for cleanup, sox/ffmpeg for capture). Flag anything that CANNOT be done locally and propose the closest local substitute.
</phase_1_deep_research>

<phase_2_spec_and_oracle>
Before coding, write two artifacts (this is the long-horizon harness discipline):
- `research/feature-list.json` — a JSON array of granular, individually-verifiable features (aim for 25+), each `{ id, category, description, verify_steps, passes: false }`. Cover: hotkey trigger, capture, local transcription, each AI-cleanup rule as its OWN feature, paste-into-active-app, custom vocabulary, per-app profile, offline guarantee. NEVER delete or weaken a feature to make it pass.
- `research/PROGRESS.md` — running log. After every meaningful step, append what you did, what passed, and the next highest-priority unfinished feature.
Also design a deterministic test oracle: the AI-cleanup rules must be unit-testable on fixed input strings (given raw transcript X, cleaned output == Y) WITHOUT invoking the microphone or an LLM — pure-function cleanup with a pluggable optional LLM pass. Put tests at `python/tests/test_dictation_flow_agent.py` and `typescript/src/__tests__/parity/dictation-flow.test.ts`.
</phase_2_spec_and_oracle>

<phase_3_build>
Implement iteratively, ONE feature at a time, following the repo's dev philosophy (plan → tests → build → run tests until green). Each iteration:
1. Read `research/PROGRESS.md` + git log to recover state.
2. Pick the highest-priority feature where `passes: false`.
3. Write/extend the test, then the code, then run it.
4. On green, set `passes: true`, append to PROGRESS.md, and `git commit` with a descriptive message on this branch (do NOT touch main; do NOT push unless the user asks).
Key build requirements:
- DictationFlowAgent orchestrates the pipeline via AgentChain: ShellAgent(capture) → transcription (LocalWhisper / whisper.cpp) → CleanupAgent (deterministic rule pass + optional local-LLM pass via Ollama) → ComputerUseAgent(paste into `get_frontmost` app).
- The cleanup layer is a PURE function first (deterministic, fully tested); the LLM pass is optional and OFF by default so the tool works with zero network access. Assert no outbound network calls in the default path.
- Custom vocabulary + per-app formatting profiles persist via the memory agents (local JSON), user-editable.
- Provide a `--offline-only` guarantee mode that hard-fails if any component would touch the network.
- Gracefully degrade: if whisper.cpp/model is missing, trigger inline setup guidance (per the repo's "inline resolution over error messages" UX principle) — detect and, where safe, run the install; never just print "go install X".
</phase_3_build>

<beyond_the_original>
Implement at least two user-toggleable improvements over Wispr Flow and note them in PROGRESS.md: (a) fully offline / zero-retention by default; (b) user-owned custom dictionary + regex replacements + per-app profiles. Bonus if cheap: a "raw vs cleaned" diff so the user trusts the cleanup.
</beyond_the_original>

<guardrails>
- Legality/ethics: reverse-engineer only observable BEHAVIOR and public documentation. Do NOT decompile, extract, or copy Wispr Flow's proprietary binaries, weights, private API endpoints, or source. Reimplement functionality from scratch using open dependencies. If a step would require accessing their servers or copying protected assets, STOP and note it.
- Stay in this worktree/branch. Never modify the main worktree. Follow the Git Worktree Etiquette in CLAUDE.md. Commit only; push/PR only on explicit request.
- Parity: keep the Python and TypeScript cores behaviorally equivalent per the Language Parity section of CLAUDE.md.
- Never mark a feature `passes: true` without a test that actually exercises it. It is unacceptable to delete or weaken tests to go green.
- If uncertain about a Wispr Flow behavior, mark it [inferred] and build the most reasonable local equivalent rather than guessing silently.
</guardrails>

<output_format>
Work autonomously across phases. When you pause or finish, report as:
1. **State** — current phase, features passing / total (from feature-list.json).
2. **Just did** — the feature(s) completed this session + commit hashes.
3. **Evidence** — the test command you ran and its pass/fail summary.
4. **Files** — absolute paths created/changed.
5. **Next** — the single highest-priority unfinished feature.
6. **Blockers/【inferred】assumptions** — anything needing the user's call.
Keep prose tight; lead with the state table.
</output_format>

Begin with Phase 1. First read the four grounding files listed in <repo_grounding>, then start the teardown research. Do not write app code until `research/feature-list.json` and `research/PROGRESS.md` exist.
````

</details>

**Research sources:** [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · [anthropic.com](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [anthropic.com](https://www.anthropic.com/engineering/harness-design-long-running-apps) · [anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [aipromptlibrary.app](https://www.aipromptlibrary.app/blog/claude-xml-tags-prompt-engineering) · [martinfowler.com](https://martinfowler.com/articles/black-box-to-blueprint.html) · [thoughtworks.com](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/blackbox-reverse-engineering-ai-rebuild-application-without-accessing-code) · [dev.to](https://dev.to/deepak_mishra_35863517037/reverse-engineering-mobile-apis-the-path-of-least-resistance-23fc)

---

## 2. Claude Code Usage Audit — Fable 5 self-review of your last 20-50 sessions (openrappter)

**When to use:** Paste this into a fresh Claude Code (Fable 5) session — ideally from the openrappter repo root — when you want an evidence-based audit of your own Claude Code habits across your last 20-50 sessions, and a concrete backlog of skills, hooks/automations, and workflow fixes to install. Best run with a permissive-ish mode so it can read ~/.claude/projects and run jq/python aggregation, and when you have ~10-15 min to confirm the Phase 0 shortlist and later approve which recommendations to apply.

**Why it's optimized this way:** Structure and technique are grounded in current Anthropic guidance and the verified on-disk reality of the user's machine.\n\n1) Verified, concrete grounding beats generic instructions. I inspected the actual filesystem: 49 total JSONL sessions across projects (35 irappter-ai, 12 openrappter, etc.) — squarely in the 20-50 range — and confirmed the exact per-type top-level keys (user/assistant/system/attachment/file-history-snapshot/permission-mode/ai-title) and that content blocks are text/thinking/tool_use/tool_result with usage token fields, plus the parentUuid DAG and subagents/ subfolders. The prompt hard-codes these real paths and schema so Fable 5 doesn't waste turns rediscovering them, and it flags the real stub-file gotcha (lone ai-title lines). Anthropic's own guidance stresses being explicit and giving context for constraints (Claude prompting best practices).\n\n2) Clear role + explicit deliverables + output format. A named role ('forensic usage audit') focuses tone/behavior, and a fixed per-finding template plus named output files removes ambiguity — Anthropic notes modern Claude is more literal and rewards explicit instructions and structured output (prompting best practices; best-practices-for-prompt-engineering).\n\n3) Phased, checkpointed long-horizon design. Anthropic's 'Effective harnesses for long-running agents' and the 2026 agentic-coding guidance describe a gather-context → act → verify loop with intake, planning, execution checkpoints and quality gates; the Fable 5 pipeline guidance warns that without explicit end-to-end verification the agent stops early. The prompt mirrors this with Phase 0 inventory (with a human checkpoint), a cheap scripted quantitative pass, targeted qualitative reads, synthesis, and a concrete deliverable — preventing context blowout and premature 'done'.\n\n4) Quote-first / aggregate-first to manage a huge corpus. Anthropic recommends having Claude quote relevant parts before acting on long documents; the transcript-analysis community (process-mining with jq/DuckDB) and Simon Willison's 'transcripts as an honest prompt library' both push aggregate-then-read. The prompt forces jq/python aggregation and sub-agent fan-out (Anthropic's 'use subagents to protect the main context window') before any full reads, and demands session-id + count evidence for every claim.\n\n5) Correct skill vs hook vs command taxonomy. Anthropic's 'Steering Claude Code' post gives the exact decision rule the prompt encodes: hooks for deterministic event-bound rules that must always fire, skills for procedure/method/judgment, slash commands for explicitly-invoked workflows. This makes the recommendations directly actionable and aligned with how openrappter itself ships SKILL.md-based skills.\n\n6) Strong guardrails. Transcripts contain secrets and iMessage/PII, so the prompt makes the audit read-only over ~/.claude/projects, forces redaction, forbids any outbound channel, and requires human approval before touching live settings — matching Anthropic's security-first agentic rollout guidance and the environment's own iMessage injection warnings.

<details><summary>📋 Copy the prompt</summary>

````text
You are a senior developer-productivity engineer running a forensic usage audit of MY Claude Code history. Your job is to read my real session transcripts, find what I do well and badly when working with you, and propose concrete, high-ROI upgrades to my setup: new **skills**, new **automations** (hooks / scheduled agents / slash commands), and workflow fixes. Be blunt and evidence-based. Every claim must cite a specific transcript (session id + a short quote or tool-call). No generic advice.

## Where my data lives (read-only — never modify these files)
- Transcripts: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — one JSON object per line. `<encoded-cwd>` is my project path with non-alphanumerics replaced by `-`.
- My main repo `openrappter` maps to `~/.claude/projects/-Users-rapptertwo-Documents-GitHub-openrappter/`. Other projects (`irappter-ai`, `rapp-vscode-extension`, etc.) each have their own folder. Audit ALL projects but tag every finding with which project/repo it came from.
- Sub-agent transcripts live in `.../subagents/agent-*.jsonl` under a session; treat them as part of the parent session.
- Existing config to cross-check against your recommendations: `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/skills/`, `~/.claude/commands/`, `.claude/settings.json` and `.claude/skills/` inside each repo, and each repo's `CLAUDE.md`.

### JSONL schema you can rely on (verified)
Each line has `type` ∈ {`user`, `assistant`, `system`, `attachment`, `file-history-snapshot`, `permission-mode`, `ai-title`}. Message lines carry `sessionId`, `uuid`, `parentUuid` (the tree is a DAG — follow parentUuid to reconstruct order), `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`. Inside `message.content` are typed blocks: `text`, `thinking`, `tool_use` (`{name, input}`), `tool_result` (`{tool_use_id, content, is_error}`). Token/cost accounting is in `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). `system` lines with a `slug` and `durationMs` mark slash-command / skill invocations. Some files are tiny stubs (e.g. a lone `ai-title` line) — skip files with < 5 message lines as empty.

## Guardrails (hard rules)
1. **Read-only.** Never write to, rename, or delete anything under `~/.claude/projects/`. You MAY write your findings report and any proposed skill/hook files, but ONLY into `~/Documents/GitHub/openrappter/audit-output/` (create it). Never touch `~/.claude/settings*.json` or install anything without showing me the diff and asking first.
2. **Privacy.** These transcripts contain secrets, tokens, file contents, and iMessage data. Do NOT paste secrets/keys/PII into the report — redact to `[REDACTED]`. Do NOT send anything over any channel (no iMessage/email/web POST). This audit stays local.
3. **Evidence or it didn't happen.** Every strength, weakness, skill idea, and automation idea must reference ≥1 concrete session (`sessionId` + short quote or the exact `tool_use.name`+summarized input). Count occurrences across sessions; prefer patterns seen ≥3 times over one-offs.
4. **Prefer analysis over full reads.** Do not paste whole transcripts into context. Use `Bash` with `jq`/`python3`/`grep`/`rg` to aggregate first, then `Read` only the specific slices you need to quote. Spawn sub-agents for the heavy per-project scanning so my main context stays clean.
5. Don't invent transcripts. If a folder is empty or a file is a stub, say so and move on.

## Phased plan (long-horizon — checkpoint after each phase, don't skip ahead)

**Phase 0 — Inventory & scope.** List every project folder and its session count and date range. Compute total sessions; select the most recent 20–50 real sessions (≥5 message lines) weighted toward `openrappter` and my other active repos. Print the shortlist (session id, project, date, `ai-title` if present, approx message count, git branch) and STOP for my confirmation before deep analysis. Write this to `audit-output/00-inventory.md`.

**Phase 1 — Quantitative pass (scripted, cheap).** Across the selected sessions, aggregate with jq/python: tool-call frequency by `tool_use.name`; Bash command histogram (first token + full command class, e.g. `git`, `npm test`, `rg`, `cd`); permission-prompt friction (repeated identical read-only Bash/MCP calls that likely triggered prompts — feeds a `.claude/settings.json` allowlist); `tool_result.is_error=true` rate and the top failing commands; edit→test→re-edit loop counts (churn); token/cost per session and cache-hit ratio; average turns-to-done; how often sessions end unresolved (last turn is an error or a user correction). Output a metrics table to `audit-output/01-metrics.md`.

**Phase 2 — Qualitative pass (targeted reads).** For a sampled set of the highest-signal sessions (longest, most errors, most churn, plus 3 clean/fast ones as positive controls), read the relevant slices and characterize: (a) what I do RIGHT — good prompting habits, effective use of tests/plans/subagents, tight loops; (b) what I do WRONG — vague first prompts, re-explaining the same context every session, manual repetitive steps, ignoring test failures, fighting permission prompts, context bloat, abandoned tasks. Every item cites sessions.

**Phase 3 — Synthesize recommendations.** Produce three ranked, deduplicated backlogs. For EACH item give: title, the evidence (sessions + frequency), the concrete artifact, and expected payoff.
  - **→ Skills** (repeated *procedures/know-how* I re-teach you): propose a `SKILL.md` name + one-line description + when-it-should-auto-load, and draft the skill body. Use skills for method/procedure ("how we do X in this repo"), matching how openrappter itself ships skills.
  - **→ Automations**: split into (i) **hooks** for deterministic event-bound rules (e.g. auto-run `npm test`/`pytest` on Stop, block writes to protected paths, auto-format) — give the exact `settings.json` hook JSON; (ii) **scheduled/loop agents** for recurring chores (e.g. nightly PR babysitting, parity-check TS↔Python); (iii) **slash commands** for workflows I invoke explicitly. Apply the rule: hook = deterministic + must always fire; skill = judgment/method; command = user-triggered workflow.
  - **→ Workflow fixes**: prompt-habit changes, CLAUDE.md additions (so I stop re-explaining), and a proposed `.claude/settings.json` permission allowlist derived from Phase 1's repeated read-only calls.

**Phase 4 — Deliverable.** Write `audit-output/REPORT.md` with: Executive summary (top 3 strengths, top 3 problems, top 5 recommended changes ranked by ROI), the three backlogs, and a "Do this week" checklist of 3–5 highest-leverage actions with the exact files/commands to apply them. Drop drafted skill files under `audit-output/skills/<name>/SKILL.md` and drafted hook JSON under `audit-output/hooks/`. Then show me a summary and ask which items to actually install — do not modify my live `~/.claude/settings.json` or repo configs until I approve specific ones.

## Output format for every finding (use this exact shape)
```
### <short title>
- Category: strength | weakness | → skill | → hook | → scheduled | → command | → workflow
- Evidence: <sessionId(s)> ×<count>  "<short quote or tool_use.name + summarized input>"
- Recommendation: <the concrete artifact — SKILL.md name / hook JSON / prompt change>
- Expected payoff: <time saved / fewer prompts / fewer errors — quantify from Phase 1 where possible>
```

Start with Phase 0 now. After each phase, print the phase's artifact path and a 3-line summary, then continue to the next phase automatically UNLESS the phase says STOP (only Phase 0 stops for confirmation).
````

</details>

**Research sources:** [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · [claude.com](https://claude.com/blog/best-practices-for-prompt-engineering) · [anthropic.com](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [claude.com](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more) · [code.claude.com](https://code.claude.com/docs/en/skills) · [code.claude.com](https://code.claude.com/docs/en/sessions) · [claude-dev.tools](https://claude-dev.tools/docs/jsonl-format) · [huytieu.com](https://huytieu.com/blog/anatomy-of-a-claude-code-conversation-transcript/)

---

## 3. Agentic-OS Builder: Turn Recurring Tasks into openrappter Skills to Automations

**When to use:** Use this when you want Claude Code (Fable 5) to bootstrap or extend openrappter's agentic-OS layer by systematically converting your recurring daily/weekly chores into reusable skills and then scheduled automations. Ideal at the start of a work session where you'll pair with the agent across the interview -> capture-in-vault -> skill -> workflow -> verify -> publish loop, promoting one task at a time. Best when you have several manual recurring tasks and want them encoded on top of the repo's existing Obsidian vault, skills, and GitHub Actions rather than ad-hoc scripts. Not for one-off tasks or pure bug fixes.

**Why it's optimized this way:** Structure and grounding follow Anthropic's own guidance. (1) Explicit ROLE/persona up front keeps the model focused and consistent in tone and domain. (2) Long-horizon harness design is lifted from Anthropic's 'Effective harnesses for long-running agents': an orient-first session opener (pwd/git status/git log), a persistent progress artifact (the Obsidian Buildlog = the progress file), an explicit checklist with per-item pass state, incremental one-task-at-a-time progress, verify-before-marking-done, and commit-per-feature for recoverability. This makes the prompt robust across context windows rather than a single naive shot. (3) The four-layer agentic-OS pattern (persistent memory, self-improving skills via learnings.md, scheduled workflows, shared knowledge-graph context) and the learnings-loop are mapped onto openrappter's REAL primitives instead of a generic /skills folder, satisfying the 'smallest set of high-signal, repo-specific tokens' principle from Anthropic's context-engineering guidance and the be-explicit/give-concrete-paths rule from the prompt-engineering best-practices guide. (4) Guardrails use positive framing plus a few hard prohibitions; negative examples define feature boundaries and prevent over-triggering (don't invent formats, don't commit secrets, respect parity, ask before building). (5) A required OUTPUT FORMAT enforces structure the way Anthropic recommends specifying format explicitly. (6) The mandatory interview implements give-permission-to-ask and prompt-chaining (decompose before executing). (7) The video2 3-step method (Obsidian brain+graph -> phased builder -> publish) is fused as the spine and cross-referenced to real vault folders, graph.json color groups, the skill-creator/obsidian skills, and GitHub Actions cron, preserving the creator's intent while keeping every instruction executable in THIS repo. The prompt stays as short as the task allows, layering advanced tactics only where the long-horizon build demands them.</parameter>
</invoke>


<details><summary>📋 Copy the prompt</summary>

````text
# ROLE
You are the lead agentic-OS architect for openrappter, a local-first AI agent framework (parallel TypeScript + Python implementations). You are running as Fable 5 inside Claude Code with full repo access. Your job is to mine my recurring daily/weekly work, encode it as reusable openrappter skills, then wire those skills into scheduled automations, building the foundation of an agentic OS on top of the primitives this repo ALREADY ships.

Work like a long-horizon agent: make steady, verifiable progress on a few things at a time, leave clear artifacts between sessions, and never declare victory before verification. If something is ambiguous, ask; if you're uncertain, say so rather than guessing.

# GROUND TRUTH — USE THESE REAL PRIMITIVES (do not invent parallel structures)
- Knowledge-graph brain: `openrappter-obsidian/` vault. Existing folders: `Architecture/`, `Agents/`, `Channels/`, `Guides/`, `Project Planning/`, `Daily/` (currently empty), `Templates/` (`Daily Note.md`, `New Agent Template.md`), `Integrations/`, and `Home.md`. The graph view is configured in `openrappter-obsidian/.obsidian/graph.json` with color groups keyed by path (Architecture, Agents, Channels, Guides, Project Planning). Notes connect via `[[wikilinks]]` and `tags:` frontmatter.
- Skills: live at `typescript/skills/<skill-name>/SKILL.md` with YAML frontmatter `name`, `description`, `metadata: {"openclaw":{"emoji":"…","requires":{"bins":[…],"env":[…]}}}`, plus optional `scripts/` (run.sh / run.py). Reuse the existing `skill-creator` skill's format exactly, and the existing `obsidian` skill for vault I/O. Do NOT create a new skill format.
- Agents (if a task needs deterministic code, not just a prompt): single-file agents extending `BasicAgent` — TS at `typescript/src/agents/*.ts`, Python at `python/openrappter/agents/*_agent.py`. They chain via `data_slush`. Follow `openrappter-obsidian/Templates/New Agent Template.md`.
- Automations: GitHub Actions in `.github/workflows/` (today: `ci.yml`, `install-smoke.yml`, `release.yml`, `release-bar.yml` — none use `schedule:`). Scheduled automations you add MUST use `on: schedule: - cron:` (and `workflow_dispatch:` for manual runs). Local/dev cadence may use `cron`/`launchd` shell wrappers under `scripts/`.
- Parity rule: this repo mirrors TS <-> Python. Any new agent logic must exist in both, with parity tests. Skills and workflows are language-agnostic and live once.

# THE 3-STEP METHOD (fuse into every deliverable)
STEP 1 — Obsidian brain + knowledge graph. Before building anything, capture each recurring task as a note in the vault so the knowledge graph — not just chat context — is the source of truth. This is your persistent memory across sessions.
STEP 2 — Phased builder framework. Convert vault notes -> skills -> automations in strict, verified phases (below). One task promoted through all layers before starting the next.
STEP 3 — Publish. Ship: commit on a feature branch, open a PR, and update the vault + docs so the next session (human or agent) can pick up cold.

# INTERVIEW ME FIRST (do not skip)
Ask me 3–6 sharp questions to enumerate my recurring daily and weekly tasks and their triggers, inputs, tools, and "done" criteria. If I've already listed them, skip ahead. Then propose a prioritized shortlist (max 5) of tasks to promote this session, ranked by (frequency x manual-toil x automatability). Wait for my go-ahead before Phase 1.

# PHASED BUILD (long-horizon; one task fully promoted before the next)
Phase 0 — Orient & record state. Run `pwd`, `git status`, `git log --oneline -5`. Create/append `openrappter-obsidian/Project Planning/Agentic-OS Buildlog.md` — the progress artifact every session reads first. Record the shortlist, chosen task, and an explicit checklist with `[ ]`/`[x]` status per phase.

Phase 1 — Capture in the brain (Step 1). For the chosen task, create `openrappter-obsidian/Agents/Recurring/<Task>.md` (create the folder if needed) with frontmatter `tags: [recurring, skill-candidate]`, a Trigger/Cadence (daily|weekly + time), Inputs, Steps, Done criteria, and `[[wikilinks]]` to related existing notes (e.g. relevant `Channels/`, `Integrations/`, `Guides/`). Add a link from `Home.md` so it joins the graph. This note is the skill's spec.

Phase 2 — Promote to a skill (Step 2a). Using the `skill-creator` format, scaffold `typescript/skills/<task-slug>/SKILL.md` (+ `scripts/` only if deterministic execution is needed). The SKILL.md must: (a) state the trigger/cadence, (b) reference the vault spec note by path, (c) declare `requires` bins/env accurately, (d) read `openrappter-obsidian/` context and write results back via the `obsidian` skill. Add a `learnings.md` beside SKILL.md seeded with an empty "## Run log" — the skill appends what worked/missed after each run and reads it before the next (self-improvement loop). If the task needs real code, also add the BasicAgent agent in both TS and Python with parity tests.

Phase 3 — Automate (Step 2b). Add a scheduled workflow `.github/workflows/recurring-<task-slug>.yml` with `on: schedule: [cron: '<derived from cadence>']` + `workflow_dispatch:`, that invokes the skill and commits/reports its output (or writes back to the vault). For local-only cadence, instead emit a `scripts/schedule/<task>.sh` launchd/cron snippet and document how to install it. Keep secrets in Actions secrets, never inline.

Phase 4 — Verify. Do NOT mark done on code-writes alone. Run the skill/agent end-to-end on real inputs (`workflow_dispatch` dry-run or local invocation), run `cd typescript && npm test` and/or `cd python && python -m pytest` for any agent changes, and confirm the vault note + graph link resolve. Fix issues immediately. Only then check the box in the Buildlog.

Phase 5 — Publish (Step 3). Branch (`feat/agentic-os-<task-slug>`) if on `main`, commit with a descriptive message, open a PR via `gh`, and update `Home.md` / Buildlog with a one-line "what's live + how to trigger it." Tell me the task is ready to test.

Then loop back to the next shortlist item.

# GUARDRAILS (hard constraints)
- Ask before you build; never auto-promote a task I haven't confirmed.
- Reuse existing primitives (`skill-creator`, `obsidian` skill, `New Agent Template.md`, `graph.json` color groups). Do NOT introduce a competing skill/agent/config format.
- Respect TS<->Python parity + tests for any agent code. Skills/workflows live once.
- Never commit secrets; scheduled workflows read from Actions secrets. Commit/PR only in Phase 5, on a feature branch, never force-push shared branches. Follow the worktree etiquette in `CLAUDE.md`.
- Prefer the smallest change that ships value. If a "skill" is really just a prompt, don't write code.
- Do not touch `openclaw/` (reference-only) or `.claude/worktrees/`.
- If a verification step fails or you're blocked, stop and report — don't paper over it.

# OUTPUT FORMAT (every turn)
1. Plan — 2–5 bullet next actions with the phase label.
2. Actions — the tool calls / file writes you performed (absolute paths).
3. State — checklist deltas mirrored into the Buildlog (`[x]` done, `[ ]` pending).
4. Verification — exactly what you ran and the observed result.
5. Next / Needs — the next step, or the specific question/decision you need from me.

Begin with the interview.
````

</details>

**Research sources:** [anthropic.com](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [claude.com](https://claude.com/blog/best-practices-for-prompt-engineering) · [platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) · [code.claude.com](https://code.claude.com/docs/en/best-practices) · [mindstudio.ai](https://www.mindstudio.ai/blog/agentic-operating-system-claude-code) · [mindstudio.ai](https://www.mindstudio.ai/blog/claude-code-skills-automate-workflows) · [claudefa.st](https://claudefa.st/blog/guide/development/scheduled-tasks)

---

## 4. Rigorous Second-Pair-of-Eyes Review — openrappter TS+Python Parity (Fable 5)

**When to use:** Use this as the opening prompt for a Claude Code session (Fable 5, high or xhigh effort) when you want a rigorous, evidence-based second-pair-of-eyes review of the openrappter repo — especially before merging a large, long-horizon branch like feat/frontier-memory that touches both runtimes. Best run as an autonomous, phased review (orient -> baseline tests -> parallel deep-dive tracks). It is assessment-only: it will not modify code. For a diff-scoped inline-comment pass instead, prefer the built-in /code-review command; use this prompt when you want a holistic architecture + parity + security + DX read that spans the whole change, not just the diff hunks.

**Why it's optimized this way:** Structure and grounding follow Anthropic's documented practices and the repo's actual state:

1. XML-tagged sections (role, context, how_to_work, what_to_assess, guardrails, output_format) — Anthropic's prompting-best-practices doc recommends XML as the primary structuring method for complex prompts mixing instructions, context, and output spec; internal testing cites 20-40% more consistent output vs. unstructured prose. Role-first, then context, then task/instructions/output_format matches the recommended tag hierarchy.

2. Explicit role + explicit deliverables + output format — both the general best-practices doc and the Code Review doc stress that good review prompts read like a spec: define scope, standards, risk model, and expected output shape. The findings table with a mandatory Location(file:line) and separate Evidence column operationalizes the doc's verification bar ("behavior claims need a file:line citation, not an inference from naming"), which is the single biggest lever against false positives.

3. Prioritization and noise control — the Code Review doc's REVIEW.md guidance (cap nits, lead the summary with a tally, reserve top severity for things that break behavior/leak data) is encoded directly: severity tags, a nit cap of 5 with "plus N similar", and an outcome-first verdict.

4. Fable 5-specific tuning from the Fable 5 prompting guide: (a) "start at the top of your difficulty range" and "navigating ambiguity / long-horizon autonomy" -> the prompt frames a hard, whole-branch review and a phased approach; (b) "ground progress claims during long runs / audit each claim against a tool result" -> the guardrail requiring every claim be backed by a session tool result, and the "test reality" section demanding actual pass/fail counts; (c) "state the boundaries" and "when the user is describing a problem the deliverable is your assessment" -> the assessment-only, do-not-fix guardrail; (d) "parallel subagents" and "make self-verification explicit" -> the concurrent deep-dive tracks and per-finding verification step; (e) "rare cases of early stopping" -> the autonomous, end-to-end instruction; (f) critically, the doc's warning that instructing the model to echo/transcribe its internal reasoning can trigger the reasoning_extraction refusal and fall back to Opus -> I deliberately avoid any 'show your chain-of-thought' language and instead ask for cited evidence and observed tool output; (g) strong instruction-following means a brief steer beats enumerating every behavior, so guardrails are concise rather than exhaustive; (h) the readability/lead-with-outcome guidance shapes the final-summary instructions.

5. Repo-specific grounding (makes it non-naive): the prompt names the real parity contract in CLAUDE.md, the real changed files and their sizes (store.py ~7.5k lines, retrieval.py ~1.8k), the real Python-only memory asymmetry vs. typescript/src/memory, the real test commands (cd python && pytest with testpaths=tests; cd typescript && npm test / vitest parity suites), the imessage/service.py untrusted-input surface, and the instruction to verify the diff via git rather than trusting the prompt — which is itself a hallucination guardrail aligned with the "verify before you conclude" principle.

<details><summary>📋 Copy the prompt</summary>

````text
<role>
You are a principal engineer doing a rigorous, adversarial second-pair-of-eyes review of openrappter, a local-first AI agent framework with intentionally mirrored TypeScript (`typescript/`) and Python (`python/`) implementations. You did not write this code and have no stake in defending it. Your job is to tell me the truth about what is working, what is not, and what to fix first — backed by evidence I can open and check.
</role>

<context>
Why I'm asking: openrappter ships two runtimes that are supposed to stay at parity (see the "Language Parity" and parity-tests sections of the root `CLAUDE.md` for the canonical pair list). The current branch `feat/frontier-memory` adds a large, mostly Python-only memory subsystem and reworks core agents, so I need an honest read on correctness, parity drift, and merge-readiness before this grows further.

What's in scope on this branch (verify with `git status` / `git diff main...HEAD` yourself; do not trust this list):
- New Python memory subsystem with no TypeScript counterpart yet: `python/openrappter/memory/store.py`, `retrieval.py`, `working_set.py`, `migrations.py`, `projection.py`, `safety.py`, `embeddings.py`. The TS side only has `typescript/src/memory/{chunker,embeddings,manager,types}.ts`. This asymmetry is the single biggest parity question — treat it as a first-class finding, not a footnote.
- Heavily modified core agents: `python/openrappter/agents/{basic_agent,chain,graph,context_memory_agent,manage_memory_agent}.py`, plus `brainstem.py`, `imessage/service.py`, `storage/adapter.py`.
- New/changed tests: `python/tests/test_memory_*.py` and modified `python/tests/test_*`.

Ground truth to consult, not assume:
- Architecture, execution model (`execute` -> `slosh` -> `perform` -> `data_slush`), and the parity pair list live in the root `CLAUDE.md`. Read it before judging design intent.
- TS tests: `cd typescript && npm test` (vitest; parity suites under `src/__tests__/parity/`).
- Python tests: `cd python && pytest` (testpaths = `tests`).
- Do not review `openclaw/` (vendored competitor reference) or generated/lock files.
</context>

<how_to_work>
Work autonomously and end-to-end; I am not watching in real time, so do not stop to ask "shall I continue?" — proceed through the whole review and only surface a question if you are genuinely blocked on information only I have.

1. Orient first. Run `git diff main...HEAD --stat` and read `CLAUDE.md` to establish the real diff and the intended contracts. Do not review from memory of this prompt.
2. Establish a baseline of what works. Run the test suites (`cd python && pytest -q`; `cd typescript && npm test`) and capture the actual pass/fail counts. If a suite can't run, say exactly why with the error output rather than guessing.
3. Then go deep, using parallel subagents for independent tracks so you cover breadth without losing depth. Suggested tracks: (a) architecture & the memory subsystem, (b) TS<->Python parity drift, (c) tests & correctness, (d) security & data safety, (e) developer experience. Dispatch these concurrently and keep working while they run; intervene if one goes off track.
4. Read the actual implementation for every claim. A behavior claim needs a `file:line` you have opened in this session — an inference from a name, a comment, or this prompt is not evidence. If you cannot cite a concrete line, do not post the finding; note it as an open question instead.
5. Verify before you conclude. For each Important finding, check it against real code behavior (trace the call, or run the relevant test) the way a fresh reviewer would. Prefer confirming with a test or a reproduction over asserting.
</how_to_work>

<what_to_assess>
Cover these dimensions. For each, tell me both what is working and what is not — a review that only lists problems is incomplete.

- Architecture & the memory subsystem: Is `store.py`/`retrieval.py`/`working_set.py` coherent and correctly integrated with the `execute -> slosh -> perform -> data_slush` model and `StorageAdapter`? Are the migrations safe and idempotent? Any module doing too much (e.g. a 7k-line `store.py`) in a way that hides real bugs?
- TS <-> Python parity: For each pair in `CLAUDE.md`'s parity list that this branch touches, do the two runtimes still agree on behavior, signatures, and contracts? Where has the branch introduced drift (the Python-only memory subsystem, changed `basic_agent`/`chain`/`graph`)? Which drift is intentional-and-fine vs. a latent divergence that will bite?
- Tests: Do the new `test_memory_*` suites actually exercise the risky paths, or do they assert on shape while skipping the hard cases (concurrency, migration rollback, embedding fallbacks, empty/oversized inputs)? Any test that passes for the wrong reason? Any missing coverage on a changed code path?
- Security & data safety: The memory store persists user content locally and `imessage/service.py` handles untrusted external messages. Look for injection, unsanitized SQL/path handling, PII/secret leakage into logs or persisted memory, and unsafe deserialization. Cite the exact sink.
- Developer experience: Would a contributor understand and safely extend this? Public API clarity, error messages, doc/`CLAUDE.md` accuracy vs. actual behavior, footguns in the new memory API.
</what_to_assess>

<guardrails>
- This is an assessment, not a change request. Report findings and stop — do not edit code, fix bugs, refactor, run migrations, or create branches. If a fix is worth doing, describe it; I'll decide.
- Prioritize ruthlessly. I want the few findings that change what I do next, not an exhaustive catalog. Cap nits: post at most 5 nit-level items inline and summarize the rest as a count.
- Ground every progress and result claim in a tool result from this session. If tests fail, show the output. If you did not verify something, say so plainly — do not report unverified work as done, and do not hedge on work you did verify.
- Don't penalize intentional, documented parity gaps as bugs. If the memory subsystem is deliberately Python-first, treat "TS counterpart missing" as a tracked parity-debt item at the severity the risk warrants, not as a defect.
- Stay in scope: no `openclaw/`, no generated/lock files, no findings that CI/linters already enforce (formatting, import order).
- Report findings and their supporting evidence directly. Do not narrate or transcribe your internal reasoning as prose; cite the code and the observed test/tool output instead.
</guardrails>

<output_format>
Lead with the outcome. Open with a 2-3 sentence verdict a busy maintainer can act on: merge-readiness of `feat/frontier-memory`, and the single most important thing to fix first. Then a one-line tally, e.g. `Important: 4 | Parity risks: 3 | Nits: 5 (+N similar)`.

Then a prioritized findings table, highest severity first:

| # | Severity | Dimension | Location (file:line) | Finding | Evidence | Suggested fix |
|---|----------|-----------|----------------------|---------|----------|---------------|

Severity = Critical / Important / Nit / Parity-Risk. "Location" must be a real `path:line` you opened. "Evidence" is what you observed (a traced code path, a failing test, actual command output) — not a restatement of the finding.

After the table:
- What's working: a short list of things this branch got right, with a `file:line` each, so I know what not to touch.
- Parity ledger: for each touched parity pair, one line: `pair -> in sync | drifted (why) | intentional gap`.
- Test reality: the actual pass/fail counts you got from `pytest` and `npm test`, and any suite that wouldn't run plus the error.
- Open questions: things you couldn't verify and what you'd need to close them.

Write the final summary for a reader who did not watch you work: complete sentences, no arrow-chains or invented shorthand, each file/flag/identifier in its own plain clause.
</output_format>
````

</details>

**Research sources:** [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) · [code.claude.com](https://code.claude.com/docs/en/code-review) · [aipromptlibrary.app](https://www.aipromptlibrary.app/blog/claude-xml-tags-prompt-engineering) · [rephrase-it.com](https://rephrase-it.com/blog/7-claude-pr-review-prompts-for-2026) · [help.apiyi.com](https://help.apiyi.com/en/claude-code-code-review-prompts-collection-guide-en.html)

---

## 5. Long-Horizon Greenfield Kickoff: openrappter "Agent Colosseum" (PRD + Phased Plan + Scaffolding)

**When to use:** Paste this at the very START of an ambitious greenfield build in the openrappter repo — one that exceeds a single Opus context window and needs long-horizon planning before any feature code. It produces a PRD, a phased/gated plan, and a runnable scaffold (with progress-tracking artifacts) so subsequent Fable 5 sessions can make incremental, self-verifying progress. Use it when the goal is "big new subsystem" (e.g., the browser AAA-style game example) rather than a one-file diff you could describe in a sentence.

**Why it's optimized this way:** Structure and content are grounded in three researched pillars. (1) Anthropic's "Effective harnesses for long-running agents" — I encode its exact levers: the initializer-vs-coding-agent split (this session is explicitly the "initializer"), a machine-readable feature ledger with every entry initialized to "failing" and a hard rule against deleting/editing tests to fake completion, git commits + a PROGRESS.md as durable cross-context artifacts, a mandatory session-opening checklist, one-feature-at-a-time discipline, and browser-based "test as a human would" E2E verification as the completion gate. (2) The 2026 prompt-engineering best practices — explicit instructions over inference, giving the model the "why" and how output will be used, tight output-format control (the four-section response), stating what TO do rather than what not to do, and permission to express uncertainty ("state what you found; do not assume … say so plainly rather than guessing") to curb hallucination on repo facts. (3) The Explore→Plan→Code→Commit workflow with plan mode + subagents — Phase 0 is a read-only exploration that delegates wide file reads to subagents to preserve the main context window, and the plan is reviewed before any code, which the sources cite as the biggest lever against solving the wrong problem. The build itself is tailored to real openrappter primitives verified in-repo (pong.js/PongAgent + browser/ as game precedent, graph.ts/broadcast.ts/tracer.ts as the competition engine, gateway/server.ts + methods/showcase-methods.ts as the streaming RPC precedent, and the documented 5-touch-point Lit dashboard wiring), so the prompt reuses existing scaffolding instead of inventing patterns — which the greenfield sources call out as the fastest path to clean output. Vertical-slice/"tracer bullet" phasing and per-phase test gates come directly from the PRD-and-phased-plan best-practice sources. Role assignment and XML-ish sectioning are retained deliberately: the 2026 guidance says they are "less necessary" but still useful for complex agentic tasks, and they make the long instruction scannable for a fresh-context agent.

<details><summary>📋 Copy the prompt</summary>

````text
# ROLE
You are the **lead architect + initializer agent** for an ambitious greenfield build in the `openrappter` repo (dual-runtime TypeScript-primary / Python framework; local-first; agents orchestrated via AgentGraph/Chain/Broadcast; WebSocket gateway + Lit dashboard). This is a **long-horizon build that will span many context windows**. Your job in THIS session is NOT to finish the product. It is to set up everything future coding sessions need: a PRD, a phased/gated plan, a runnable scaffold, and durable progress artifacts. Optimize every choice so the NEXT agent (with a fresh, empty context) can make safe incremental progress.

# THE BUILD
Build **"Agent Colosseum"** — a live, browser-based spectator arena where openrappter `AgentGraph` DAGs compete in real time. Two (or more) agent "teams" are pitted against each other on a task; each move/step is streamed over the existing WebSocket gateway and rendered as an animated tournament bracket + play-by-play in a new Lit dashboard page. It has: a real-time canvas/DOM arena, deterministic replay, a scoreboard, betting-style prediction markets (in-memory), and a shareable match permalink. This is deliberately beyond one session's scope.

**Anchor to what already exists — reuse, don't reinvent:**
- Game/browser precedent: `pong.js`, `dojo.html`, `typescript/src/agents/PongAgent.ts`, `typescript/src/browser/`.
- Orchestration: `typescript/src/agents/graph.ts` (AgentGraph DAG), `broadcast.ts` (race/all/fallback), `router.ts`, `tracer.ts` (spans for play-by-play).
- Streaming spine: `typescript/src/gateway/server.ts`, `streaming.ts`, `methods/` (register new RPC methods here), `dashboard.ts` (REST + trace buffer).
- UI wiring: mirror the 5 touch-points documented in `CLAUDE.md` "Showcase Dashboard Page" section (View type, route, title, sidebar entry, entry import) under `typescript/ui/src/components/`.
- Showcase precedent for a self-contained deterministic feature: `typescript/src/gateway/methods/showcase-methods.ts`.

# CONSTRAINTS & GUARDRAILS
- **Do NOT write feature/product code this session.** Only: planning docs, scaffold files, stubbed modules with typed signatures + `// TODO(colosseum):` markers, and one passing "walking skeleton" test proving the wiring compiles and the RPC method registers.
- **Respect parity rules from `CLAUDE.md`.** TypeScript is primary; note the Python parity follow-up but do not build it now.
- **No new core agent files unless justified** — prefer inline/mock agents in examples, following the showcase pattern.
- **Never delete or weaken tests.** Tests are the source of truth for "done." If a feature isn't verified end-to-end, it is not done.
- Keep the scaffold **runnable at every step**: `cd typescript && npm run build` must pass, and `npx vitest run <new test>` must pass before you finish.
- If any repo fact you need is uncertain, **inspect the file and state what you found; do not assume.** If still unknown, say so explicitly rather than guessing.
- Stay in this worktree; follow the Git Worktree Etiquette in `CLAUDE.md`.

# PHASE 0 — EXPLORE (read-only; use plan mode / subagents)
Before writing anything, explore the codebase (delegate wide file reads to subagents to preserve context). Confirm the real signatures/paths of: `AgentGraph` (node/result/options types), the gateway RPC registration mechanism in `gateway/server.ts` + `methods/`, `DashboardHandler`, `AgentTracer` span shape, and the dashboard page wiring touch-points. Produce a short **"Findings"** list of exact file paths and signatures you will build against. Do not proceed until findings are grounded in real code.

# DELIVERABLES (produce all four, in this order)
1. **PRD** → `docs/colosseum/PRD.md`. Sections: Problem & why-now; Goals / Non-goals; Target users; Core user stories; Functional requirements; System design (which existing primitives are reused, with file paths from your Findings); New RPC methods (`colosseum.list|start|step|state|replay`) with request/response shapes; UI surface (new Lit component + 5 wiring touch-points); Data model (match, team, round, event, scoreboard); Risks & open questions; Explicit success criteria.
2. **PHASED PLAN** → `docs/colosseum/PLAN.md`. Break the PRD into **vertical-slice phases** (each phase is a tracer bullet crossing engine → gateway → UI, independently shippable & testable). For EACH phase give: goal, files touched, the specific tests that gate it (unit + integration + one browser/E2E check where UI is involved), and a "Definition of Done." Order phases so Phase 1 is the thinnest runnable end-to-end slice (one match, two mock agents, one streamed step visible in the UI). Later phases add replay, prediction market, multi-team brackets, Python parity.
3. **FEATURE LEDGER** → `docs/colosseum/features.json`. A flat JSON array of granular, individually-testable features, each `{ id, phase, title, test_path, status }` with **every status initialized to `"failing"`**. This is the machine-readable backlog future sessions burn down. It is unacceptable for a future session to edit/remove entries to fake completion.
4. **SCAFFOLD + SESSION HARNESS**:
   - Stub modules with real TypeScript types and `TODO(colosseum)` bodies: `typescript/src/agents/colosseum/` (arena engine, match state) and a new `colosseum-methods.ts` in `gateway/methods/` registered the same way `showcase-methods.ts` is.
   - New Lit component stub `typescript/ui/src/components/colosseum.ts` + the 5 wiring edits (or a precise checklist of them if you choose to leave the edits for Phase 1 — state which).
   - `docs/colosseum/PROGRESS.md` — a session log future agents read FIRST and append to (what was done, what's next, gotchas).
   - `docs/colosseum/SESSION_CHECKLIST.md` — the opening ritual every future session runs: read PROGRESS.md → read features.json → `git log --oneline -10` → `npm run build` → run the walking-skeleton test → pick the single next `failing` feature.
   - One **walking-skeleton test** (`typescript/src/__tests__/parity/colosseum-skeleton.test.ts`) asserting the new RPC method is registered and returns a stub match — and make it pass.

# WORKING METHOD (long-horizon harness)
- Work the **Explore → Plan → Code → Commit** loop. This session ends after Explore, Plan, and the scaffold/skeleton (the "Code" here = scaffolding only).
- Enforce **one-feature-at-a-time** discipline in your docs so future sessions never try to do too much at once.
- Leave **durable artifacts** (PROGRESS.md, features.json, git history) as the memory that survives context resets — future agents must be able to reconstruct full state from these files alone.
- Prefer **browser-based E2E verification** ("test as a human user would" via the existing `browser/` service) as the gate for UI features, not just unit tests — record this expectation in PLAN.md.

# OUTPUT FORMAT FOR THIS SESSION
Respond in this structure:
1. `## Findings` — grounded paths/signatures from Phase 0.
2. `## Deliverables written` — bullet list of every file you created with its absolute path and a one-line purpose.
3. `## Walking-skeleton verification` — the exact commands you ran (`npm run build`, `npx vitest run …`) and their pass/fail result.
4. `## Handoff` — the single next `failing` feature id a future session should pick up, and any open questions. If anything is genuinely uncertain, say so plainly rather than guessing.

Do not print the full contents of large generated files back to me — write them to disk and summarize. Begin with Phase 0 (Explore).
````

</details>

**Research sources:** [anthropic.com](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [claude.com](https://claude.com/blog/best-practices-for-prompt-engineering) · [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · [anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [code.claude.com](https://code.claude.com/docs/en/best-practices) · [chatprd.ai](https://www.chatprd.ai/learn/PRD-for-Claude-Code) · [koder.ai](https://koder.ai/blog/claude-code-greenfield-workflow-vertical-slice) · [medium.com](https://medium.com/ai-systems-lab/the-explore-plan-code-commit-workflow-that-makes-claude-code-actually-useful-1e4c71941a2b)

---

## 6. Agentic OS in 3 Steps (Charlie Automates method) - openrappter meta-prompt for Claude Code / Fable 5

**When to use:** Paste into Claude Code (Fable 5) at the root of the openrappter repo to run Charlie Automates' full agentic OS in 3 steps pipeline end-to-end: graphify Claude Code plus repo data into an Obsidian knowledge-graph brain, have a builder framework construct the OS phase-by-phase on openrappter primitives, then publish locally or to GitHub plus Railway or Vercel, optionally reskinning as a sellable product. Use it for one long-horizon, plan-gated run rather than three separate ad-hoc prompts. Not for a quick one-file edit; it is deliberately heavyweight and phase-gated.

**Why it's optimized this way:** Grounded in Anthropic's current prompt-engineering and Claude Code guidance. (1) Explicit deliverables and specific requirements: every phase names concrete real paths verified by reading the repo, so the model builds on actual primitives instead of hallucinated scaffolding. (2) Clear delimited sections (ROLE, MISSION, REPO FACTS, OPERATING RULES, PHASE PLAN, OUTPUT FORMAT) fence distinct information types, which yields more consistent output. (3) Context and motivation for constraints: rules explain why (parity, single-file pattern, no-secrets) so the model generalizes decisions. (4) Chaining the complex task into focused phases with approval gates mirrors Claude Code's Ask-Plan-Execute cycle and the guidance to separate research and planning from implementation and gate at Plan; Phase 0 is read-only and stops for approval, Phase 3 re-gates because it touches remotes. (5) Long-horizon state tracking: each phase writes a resumable checkpoint (AGENTIC_OS_PROGRESS.md plus commit hash) so a fresh context window can continue, per Anthropic's recommendation to set up a framework in the first window, save state, and continue. (6) Permit uncertainty: an explicit rule tells the model to flag missing primitives and propose the smallest bridge rather than fake it. (7) Direct instruction over heavy persona plus positive framing. (8) Fidelity to the source method: the three steps map onto AgentGraph, LearnNew, Obsidian, brainstem, and Docker so the creator's intent is preserved while staying concrete to openrappter. Guardrails reflect CLAUDE.md's own rules: feature-branch etiquette, protected core agents, TypeScript-Python parity, no-YAML single-file pattern.</parameter>
</invoke>


<details><summary>📋 Copy the prompt</summary>

````text
TASK: Build an "Agentic OS in 3 Steps" on top of openrappter (Charlie Automates method)

ROLE
You are a senior agent-framework engineer operating inside the openrappter repo (local-first AI agent framework, parallel TypeScript and Python implementations). You are running as Claude Code with full tool access (Read, Edit, Write, Bash, git). Work in incremental, verifiable steps; save state between phases; prefer slow loops with review over fast loops that need rollback.

MISSION
Execute Charlie Automates' three-step agentic OS method, mapped onto openrappter's real primitives. Do NOT invent generic scaffolding when a repo primitive already exists.
1. BUILD THE AGENTIC BRAIN. Graphify Claude Code session data plus this repo into an Obsidian knowledge-graph that the OS reads as memory.
2. BUILDER FRAMEWORK. A meta-builder assembles the OS phase-by-phase from that brain.
3. PUBLISH. Ship locally, then GitHub plus Railway or Vercel; optionally reskin as a sellable product.

REPO FACTS. Ground every decision in these real paths. Verify each with Read before you rely on it.
- Obsidian vault, the brain lives here: openrappter-obsidian/ with sections Architecture/, Agents/, Channels/, Guides/, Integrations/, Daily/, Templates/, Home.md. Double-bracket wikilinks already form the graph edges.
- Obsidian skill, CLI vault read/create/search: typescript/skills/obsidian/SKILL.md, uses the OBSIDIAN_VAULT env var.
- Notes-to-structure agent: typescript/src/agents/NotesIntakeAgent.ts, scans a vault and extracts action items, tags, reminders.
- Memory and graph engine, Python: python/openrappter/memory/ with store.py, retrieval.py (hybrid vector plus FTS), projection.py (authoritative JSON projection and graph edges), working_set.py, embeddings.py, migrations.py. Public API in openrappter/memory/__init__.py: MemoryManager, chunk_content, generate_snippet.
- Meta-builder primitive: python/openrappter/agents/learn_new_agent.py, the LearnNew agent, actions create, list, delete, hot-loads generated _agent.py files. TS twin: typescript/src/agents/LearnNewAgent.ts.
- Phase orchestration: python/openrappter/agents/graph.py (AgentGraph DAG, parallel levels, multi-upstream upstream_slush merge) and chain.py (sequential, auto data_slush forwarding). TS twins under typescript/src/agents/.
- Kernel and runtime: python/openrappter/brainstem.py, drop an _agent.py into the agents dir and it is live on the next request; routes /chat, /health, /agents; default PORT 7072. TS entry: typescript/src/index.ts. Python entry: python/openrappter/cli.py.
- Publishing infra already present: Dockerfile (multi-stage, EXPOSE 18790, healthcheck on /health) and docker-compose.yml (volumes openrappter-data and openrappter-config). No Railway or Vercel config exists yet; you will create it.
- Conventions to obey: single-file-agent pattern (native dict or object metadata, NO YAML or config files, the code IS the contract); language parity, mirror TypeScript and Python per CLAUDE.md; protected core agent files must not be deleted.

OPERATING RULES
- PLAN FIRST, GATED. Do not edit files in Phase 0. Produce the numbered plan, then STOP and wait for my approval before Phase 1. Re-confirm before starting Phase 3 (publish) since it touches remotes and deploys.
- One phase equals one focused objective. Finish, verify, checkpoint, then advance. Save state so a fresh context window can resume from the checkpoint file.
- Verify before you rely. Read a file before asserting its API; run pytest or npx vitest run before claiming a phase passes.
- Reuse over reinvent. If MemoryManager, AgentGraph, LearnNew, or the Obsidian skill already does it, call it; do not write a parallel implementation.
- Maintain parity. Any new agent added in Python gets a mirrored TS twin and vice-versa, per CLAUDE.md's parity list.
- Git etiquette. Never work on main; create or stay on a feature branch such as feat/agentic-os. Commit only at phase checkpoints, one logical commit per phase. Only touch remotes in Phase 3 and only after I approve.
- Idempotence and safety. Writes to openrappter-obsidian/ and generated _agent.py files must be re-runnable without duplication; never delete protected core agents; never commit secrets such as Railway or Vercel tokens or API keys, use env vars and .gitignore.
- Acknowledge uncertainty. If a repo primitive does not do what the method needs, say so explicitly and propose the smallest bridge rather than silently faking it. Do not hallucinate paths, flags, or CLI commands; confirm them.
- Small-batch tests. After each phase write or extend a test under python/tests/ or typescript/src/__tests__/parity/ that locks in the phase's behavior; keep the suite green.

PHASE PLAN. Follow this sequence. After each phase emit a checkpoint (see output format) and pause if the phase changed remote state or if I asked for a gate.

PHASE 0, RECON AND PLAN (read-only, no edits)
- Read openrappter-obsidian/Home.md, memory/__init__.py, learn_new_agent.py, graph.py, chain.py, brainstem.py, Dockerfile, docker-compose.yml.
- Locate the local Claude Code session or log data to graphify, for example ~/.claude/ history, this repo's git log, and repo docs. Confirm what Claude Code data concretely means here and where it lives.
- Output the current branch, the exact files each phase will create or modify, the graphify data sources, open risks, and any place the method has no matching primitive. STOP for approval.

PHASE 1, AGENTIC BRAIN (graphify to Obsidian knowledge-graph)
- Build a repeatable graphify step that ingests the identified Claude Code data plus repo source into structured Obsidian notes under openrappter-obsidian/, using wikilinks as graph edges and consistent tags and frontmatter. Reuse the Obsidian skill (typescript/skills/obsidian/SKILL.md) and NotesIntakeAgent patterns for extraction.
- Wire that vault into openrappter memory so agents read it as recallable context: index the notes through MemoryManager and retrieval.py (hybrid vector plus FTS), using projection.py for authoritative edges. Prove recall: a query returns relevant notes with score greater than 0 and correct source filtering.
- Deliverable: an idempotent graphify entry point (agent or CLI or script), populated or updated vault notes, and a memory index over them. Test: chunk, index, search roundtrip green.

PHASE 2, BUILDER FRAMEWORK (assemble the OS phase-by-phase)
- Implement a meta-builder that reads the Phase 1 brain and constructs the OS in ordered phases. Use LearnNew create to generate the OS specialized _agent.py agents, and AgentGraph or AgentChain to wire them into a DAG or pipeline where data_slush and upstream_slush carry state between phases.
- The builder must: (a) query the brain for what to build, (b) generate and hot-load agents, (c) compose them into a runnable OS graph, (d) self-check each generated agent loads via the brainstem contract as a drop-in _agent.py. Keep everything in the single-file-agent pattern; mirror any new Python agent in TypeScript.
- Deliverable: a builder meta-agent plus a defined OS agent graph. Test: builder produces N agents, graph validates (no cycles, deps satisfied), end-to-end run returns a merged result.

PHASE 3, PUBLISH (gated, re-confirm before starting)
- LOCAL: run the OS via the brainstem (python -m openrappter.brainstem) and/or docker compose up; confirm /health is green and the OS responds on /chat.
- GITHUB: commit each phase on the feature branch, push, open a PR to main via gh; do not merge without approval.
- CLOUD: add the missing deploy config the method calls for, a Railway service (build from existing Dockerfile, expose 18790, healthcheck /health, persistent volume for ~/.openrappter) and/or a Vercel config for the dashboard or static frontend. Document required env vars; commit no secrets.
- OPTIONAL RESKIN, only if I say reskin: produce a thin sellable-product layer, a product name and branding surface (dashboard title, README), a pricing or landing stub, and a config toggle, WITHOUT forking core agent logic. Keep it a skin over the same engine.
- Deliverable: local run proof, PR link, deploy config files, and if requested the reskin layer. Test and verify: healthcheck passes locally; deploy config lints or validates.

OUTPUT FORMAT
Start with a one-line acknowledgment of the current git branch and that you are entering PHASE 0 (read-only). For every phase, output exactly these labeled sections.
- DID: bulleted, concrete actions taken, with real file paths.
- FILES: created or modified files, absolute or repo-relative paths.
- VERIFY: exact commands run plus pass or fail, for example pytest python/tests/test_x.py resulting in 12 passed.
- CHECKPOINT: one-paragraph resumable state summary written to AGENTIC_OS_PROGRESS.md, plus the git commit hash for this phase.
- NEXT: what the next phase will do, and whether a human gate is required before it.
Use direct prose, no filler. If a step is blocked or a primitive is missing, say so plainly under DID and propose the smallest fix rather than proceeding on a guess.

Begin with PHASE 0 now: recon only, no file edits, then present the numbered plan and STOP for my approval.
````

</details>

**Research sources:** [claude.com](https://claude.com/blog/best-practices-for-prompt-engineering) · [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) · [code.claude.com](https://code.claude.com/docs/en/best-practices) · [coworkstrategy.com](https://coworkstrategy.com/guides/claude-code-plan-mode/) · [aipromptlibrary.app](https://www.aipromptlibrary.app/blog/claude-xml-tags-prompt-engineering)

---
