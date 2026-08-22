# Fable 5 Deliverable

> Generated 2026-07-16 by a Claude Code multi-agent workflow (23 agents) and expanded 2026-08-21 with the Rapter Clever Girl Observe Mode audit and scope gate. Durable, in-repo output from the Fable 5 use-case exercise for openrappter.

## Contents

- **[FABLE5_PLAYBOOK.md](FABLE5_PLAYBOOK.md)** — 6 deep-research-optimized, copy-paste prompts (5 Chase AI use cases + Charlie Automates' 3-step agentic-OS method).
- **[reports/usage-audit.md](reports/usage-audit.md)** — your Claude Code usage audit → skills + automations.
- **[reports/usage-audit-2026-08-21.md](reports/usage-audit-2026-08-21.md)** — evidence-based 30-day Copilot CLI audit and ranked Clever Girl candidates.
- **[reports/repository-activity-audit-2026-08-21.md](reports/repository-activity-audit-2026-08-21.md)** — PR, CI, release, and correction-loop audit with the inert exact-head merge-gate candidate.
- **[reports/rapter-clever-girl-observe.md](reports/rapter-clever-girl-observe.md)** — incumbent research, minimum lovable scope, kill criteria, and final GO.
- **[reports/rapter-clever-girl-dogfood.json](reports/rapter-clever-girl-dogfood.json)** — privacy-safe, source-digested output regenerated from the committed redacted dogfood ledger.
- **[reports/rapter-clever-girl-dogfood-input.jsonl](reports/rapter-clever-girl-dogfood-input.jsonl)** — wholly synthetic/redacted ledger that reproduces the private dogfood's aggregate workflow shape.
- **[reports/rapter-clever-girl-benchmark.json](reports/rapter-clever-girl-benchmark.json)** — reproducible 20-process determinism and latency measurement over the redacted ledger.
- **[reports/code-review.md](reports/code-review.md)** — 45-finding, 5-dimension review of openrappter.
- **[reports/agentic-os-foundation.md](reports/agentic-os-foundation.md)** — the agentic-OS blueprint + phased roadmap.
- **[reports/assimilation-into-openrappter.md](reports/assimilation-into-openrappter.md)** — competitive deep-read of OpenClaw/Hermes/Pi/OpenHands/Claude Code → prioritized assimilation backlog + adversarial critique.
- **[transcripts/](transcripts)** — verbatim transcripts + source video metadata.
- **[automations/](automations)** — 4 safe, dispatch-gated CI/automation stubs.
- **[../.claude/skills/](../.claude/skills)** — 7 runnable project skills, including Fable5 Pass and Rapter Clever Girl Observe Mode.

## The 7 skills

- **[Fable5 Pass](../.claude/skills/fable5-pass/SKILL.md)** — Runs the durable usage-audit, code-review, agentic-OS, prompt, skill, and safe-automation-stub workflow on a selected project.
- **[Release Reviewer](../.claude/skills/release-reviewer/SKILL.md)** — Runs a strictly read-only adversarial final review of the current diff against HEAD, traces every claim to evidence, and emits VERIFIED/REFUTED/UNPROVEN plus GO/NO-GO.
- **[Video to Prompts](../.claude/skills/video-to-prompts/SKILL.md)** — Extracts a supported video's transcript, distills its suggestions into runnable prompts, and can research improved prompt drafts.
- **[iMessage Persona Bot](../.claude/skills/imessage-persona-bot/SKILL.md)** — Keeps one named persona specification for an explicitly selected chat and binds the corresponding responder trigger without duplicating persona rules.
- **[TS Python Parity Check](../.claude/skills/ts-python-parity-check/SKILL.md)** — Compares mirrored OpenRappter modules, public behavior, and parity-test coverage, then emits a structured parity report.
- **[CLAUDE.md Generator](../.claude/skills/claude-md-generator/SKILL.md)** — Produces or refreshes high-signal project instructions grounded in real build commands, architecture, key modules, and conventions.
- **[Rapter Clever Girl Observe Mode](../.claude/skills/rapter-clever-girl-observe/SKILL.md)** — Locally mines explicitly supplied assistant-history exports for repeated friction, collision-checks existing skills, and returns at most five evidence-backed inert proposals; it never applies or creates anything.

## Activating the automations

The files in `automations/` are **stubs** kept outside `.github/workflows/` so they never run automatically. To activate one, review it and move it into `.github/workflows/`. Each is `workflow_dispatch`-gated and contains no destructive/deploy steps by default.
