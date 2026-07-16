# Fable 5 Deliverable

> Generated 2026-07-16 by a Claude Code multi-agent workflow (23 agents). Durable, in-repo output from the Fable 5 use-case exercise for openrappter.

## Contents

- **[FABLE5_PLAYBOOK.md](FABLE5_PLAYBOOK.md)** — 6 deep-research-optimized, copy-paste prompts (5 Chase AI use cases + Charlie Automates' 3-step agentic-OS method).
- **[reports/usage-audit.md](reports/usage-audit.md)** — your Claude Code usage audit → skills + automations.
- **[reports/code-review.md](reports/code-review.md)** — 45-finding, 5-dimension review of openrappter.
- **[reports/agentic-os-foundation.md](reports/agentic-os-foundation.md)** — the agentic-OS blueprint + phased roadmap.
- **[transcripts/](transcripts)** — verbatim transcripts + source video metadata.
- **[automations/](automations)** — 4 safe, dispatch-gated CI/automation stubs.
- **[../.claude/skills/](../.claude/skills)** — 5 runnable Claude Code skills generated from the audit.

## The 5 skills

- **Release Reviewer** — Runs a strictly read only adversarial final release review of the current diff against HEAD. It traces every claim to code, checks tests and evidence counts, and hunts for auth, replay, race, cost storm, and regression gaps. It takes a version tag and a claims to verify list and emits a per claim verdict of verified refuted or unproven plus a release go or no go.
- **Video to Prompts** — Given a video URL, extracts the transcript with yt dlp using android web_safari and ios player_client fallbacks and json3 or vtt caption dedup, distills each suggested action into a prompt, optionally deep researches to optimize each prompt, and writes the final drafts to a durable location. It can optionally chain into executing each prompt locally one by one.
- **iMessage Persona Bot** — Defines a named chat persona once, including identity, mention aliases that always get a reply, tone, never answer for X rules, and read the room selectivity, then installs the matching trigger against a specific chat id, with the persona living in a single spec file rather than restated in every cron prompt.
- **TS Python Parity Check** — Cross checks the OpenRappter TypeScript and Python mirror implementations for a given module such as BasicAgent, ShellAgent, broadcast, router, chain, or graph. It diffs public API and behavior, flags divergences, and confirms the parity test suites cover the change, then emits a structured parity report.
- **CLAUDE md Generator** — Analyzes a repo build and test commands, architecture, key modules, and conventions and produces or refreshes a high signal CLAUDE dot md tailored to that codebase, in the dense but navigable style the user favors.

## Activating the automations

The files in `automations/` are **stubs** kept outside `.github/workflows/` so they never run automatically. To activate one, review it and move it into `.github/workflows/`. Each is `workflow_dispatch`-gated and contains no destructive/deploy steps by default.
