---
name: fable5-pass
description: Run the full "Fable 5 pass" on any repo, project, or video in the current context — a usage audit of your Claude Code, an evidence-based code review, an agentic-OS scaffold (recurring tasks → skills → automations), and deep-research-optimized prompts — then assemble durable deliverables (playbook + reports + generated skills + safe automation stubs) and optionally commit/PR and save to Apple Notes. Use WHEN the user says "run a fable 5 pass", "do the fable 5 thing here", "get the most out of Fable 5 on this project", pastes a video of Fable/agent use-cases to apply, or asks to turn this project into an agentic OS. Works anywhere; installed at user scope so it's invocable in every project.
---

# Fable 5 Pass

A portable, repeatable version of the "get the most out of Fable 5" workflow. Point it at the current repo (default), a specific path, or a video URL, and it produces durable, in-repo deliverables. It is model-agnostic — it just works best with the most capable model available.

The five source use cases (Chase AI) + the 3-step agentic-OS method (Charlie Automates) this skill operationalizes:
1. **Clone & customize** a paid app locally (deep-research → local rebuild).
2. **Usage audit** of your Claude Code sessions → what to turn into skills/automations.
3. **Agentic OS** — daily/weekly tasks → skills → automations, on the project's own primitives.
4. **Code review** — a rigorous second pair of eyes on a complex project.
5. **Ambitious build** — kick off a long-horizon greenfield project (PRD + phased plan).

## When to run which part

- **Default (`/fable5-pass`)** → run the *agentic-OS backbone*: usage audit (#2) + code review (#4) + agentic-OS scaffold (#3), plus the optimized prompt playbook.
- **With a path (`/fable5-pass <repo-or-dir>`)** → same, scoped to that target.
- **With a video URL (`/fable5-pass <youtube-url>`)** → transcribe first (see step 1b), extract the creator's suggestions, turn each into an optimized prompt, then optionally execute them.
- **On request** → run the one-off use cases: clone-an-app (#1) or ambitious-build (#5).

## Guardrails (read first)

- **Confirm blast radius before anything irreversible.** If the pass will commit/push to one or more repos, confirm scope + delivery (new branch + PR vs. push to main vs. local-only) *before* writing. Never write deliverables into many repos without explicit per-scope confirmation.
- **Isolate.** For a repo, do the work in a dedicated git worktree branched off the default branch (`git worktree add -b fable5/agentic-os-scaffold <path> origin/main`) so in-progress work on other branches is untouched and the PR is clean.
- **Code review is read-only.** Never mutate code while reviewing; every finding must cite real evidence (`file:line`).
- **Automations are stubs by default.** Write generated CI/automation files to `fable5/automations/`, NOT `.github/workflows/`, so nothing runs automatically. Each must be `workflow_dispatch`-gated with no destructive/deploy steps until the user moves it.
- **Local-first.** Prefer the project's own primitives and on-device tooling over new cloud dependencies.

## Procedure

### 0. Scope
Determine the target and desired durability. If unclear and the answer changes what you write (which repos? push or PR? save to Notes?), ask concise clarifying questions. Otherwise proceed with sensible defaults: current repo, isolated worktree, new branch + PR, Apple Notes + repo files.

### 1. Gather ground truth
- **1a. Project context:** read `CLAUDE.md`/`AGENTS.md`, `README`, top-level structure, test/CI config, and any existing `.claude/skills/`. Note the project's own primitives (memory, agents, channels, Actions, docs vaults) so the agentic-OS layer reuses them.
- **1b. (If a video/URL was given) Transcribe:** use `yt-dlp` auto-captions —
  ```
  python3 -m yt_dlp --skip-download --write-auto-subs --sub-langs "en.*" \
    --sub-format "json3/vtt/best" \
    --extractor-args "youtube:player_client=web_safari,tv,android,ios" \
    -o "/tmp/fable5/vid.%(ext)s" "<URL>"
  ```
  Parse json3/vtt → clean text. Fallback: download audio and transcribe with a local whisper/whisper.cpp if captions are unavailable. Extract the speaker's discrete suggestions.
- **1c. Usage-audit input:** digest `~/.claude/projects/*/*.jsonl` into a compact per-session summary (first user message, tool counts, slash commands, model) to feed the audit.

### 2. Fan out the work (use a Workflow if available)
If the Workflow tool is available, orchestrate the heavy parts as one workflow with structured (schema) outputs; otherwise run sequential subagents or do it inline. Produce:
- **Usage audit** — strengths, weaknesses, `candidateSkills` (kebab-case slug, description, trigger, why), `candidateAutomations` (trigger, mechanism, why).
- **Code review** — fan out across dimensions (architecture/parity, tests/CI, security, docs/DX, runtime quality); each finding evidence-based; then synthesize an executive summary + prioritized top actions; flag low-confidence findings.
- **Agentic-OS foundation** — brain / skills / automations / publish layers mapped onto the project's primitives, a phased roadmap, and quick wins.
- **Optimized prompts** — for each use case (and each extracted video suggestion), a deep-research-grounded, copy-paste prompt tailored to this project. Search the web for current best practices; cite sources; use a clear role, explicit deliverables, guardrails, output format, and a phased approach for long-horizon tasks.
- **Generated skill files** — a real `SKILL.md` (YAML frontmatter: `name`, `description` incl. WHEN to use; then a runnable body) per top candidate skill.
- **Automation stubs** — safe, dispatch-gated files per top candidate automation.

### 3. Assemble durable deliverables
Write into the target (worktree) — deterministic file writing, done by you, not sub-agents:
```
fable5/
  README.md                     # index
  FABLE5_PLAYBOOK.md            # the optimized prompts (each in a copy-paste code fence)
  reports/usage-audit.md
  reports/code-review.md
  reports/agentic-os-foundation.md
  transcripts/                  # if videos were ingested: verbatim text + SOURCES.md
  automations/*.yml             # safe stubs (NOT in .github/workflows)
.claude/skills/<slug>/SKILL.md  # generated, project-scoped skills
```
Wrap every prompt in a ```` ```text ```` fence so angle-bracket tags render literally and stay copy-pasteable.

### 4. Persist
- **Apple Notes (macOS):** create a summary note via `osascript`:
  ```
  osascript -e 'tell application "Notes" to make new note at folder "Notes" of account "iCloud" with properties {name:"Fable 5 Playbook — <project>", body:"<html>"}'
  ```
  (HTML body; escape quotes; keep it a readable summary + links back to the repo files.)
- **Git:** stage the `fable5/` and `.claude/` additions, commit on the `fable5/*` branch, and — per the confirmed delivery mode — push and open a PR (`gh pr create`) against the default branch. Report the PR URL. Do not push to `main` unless explicitly told.

### 5. Report
Summarize what was produced, the top code-review actions, the agentic-OS quick wins, the generated skills, and the PR link. Offer to execute any one-off use case (#1 clone-an-app, #5 ambitious-build) next.

## Notes
- This skill created the openrappter Fable 5 deliverable (`fable5/` + `.claude/skills/`) that ships alongside it — that repo is a worked reference example of the output shape.
- Keep it model-agnostic: the value is the harness (audit → review → scaffold → optimized prompts → durable artifacts), not any one model.
