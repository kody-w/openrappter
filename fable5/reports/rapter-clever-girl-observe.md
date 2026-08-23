# Rapter Clever Girl Observe Mode — Product Research and Scope Gate

> Research checkpoint: 2026-08-21. Verdict: **GO** for the minimum lovable
> Observe Mode only.

## Executive verdict

The harsh critic initially issued a conditional GO. The final independent
release gate issued **GO** after all conditions and prior NO-GO findings were
closed. The decision still depends on refusing the obvious product expansion.

There is no credible standalone opportunity in another history viewer,
transcript search tool, summarizer, skill generator, “productivity” score, or
always-on watcher. Those surfaces are occupied and would weaken the privacy
boundary. The lovable wedge is one local command that accepts explicit
cross-assistant exports, emits no raw text, collision-checks existing skills,
reports conservative active-friction ranges, and stops at no more than five
inert proposals.

No category-first claim is made. Chronicle and Lore overlap heavily;
differentiation is the conjunction of **cross-assistant inputs,
existing-capability collision checks, active-friction ranges, and no apply
path**.

## Verified incumbents

| Incumbent | Verified primary-source capability | Consequence for Clever Girl |
|---|---|---|
| **GitHub Chronicle** | Copilot session data is local and, by default, synced to GitHub. `/chronicle` provides standups, tips, cost tips, search, and suggestions for improving custom instructions; its `improve` flow can update instructions after selection. | Do not build a Copilot history query, summary, tips, cost, or instruction-apply product. |
| **OpenAI Codex Memories** | A feature-gated background pipeline extracts rollout memories, consolidates them, and can update local memory and skills. | Do not claim session-to-skill novelty; Clever Girl has no memory writer or skill generator. |
| **SpecStory Lore** | Mines recurring intent/tool/outcome "beats," inventories installed skills, suppresses duplicates, and can forge approved skills and symlinks. | Treat duplicate-aware proposals as the baseline; Clever Girl differentiates by having no database or apply path. |
| **`session-analytics`** | Local Claude/Codex analysis covers outcomes, repeated friction, rule effectiveness, and evidence-tied config proposals; its query mode is read-only. | Do not claim workflow-mining novelty or turn open-session span into active time. |
| **`meta-cc`** | Local recurring error/fix, edit-sequence, work-pattern, quality, and tech-debt analysis over Claude and Codex. | Do not claim that local recurring-pattern analysis is unique. |
| **History viewers/searchers** | Claude Code History Viewer, `cass`, AgentsView, and `sessiongrep` already provide cross-assistant local search, timelines, exports, and usage analytics. | Cross-assistant parsing alone is not differentiation. No Clever Girl viewer. |
| **LangSmith/PostHog/Phoenix** | Instrumented traces support observability, failure clustering, replay, and evidence-backed reports or PRs. They do not import arbitrary local coding-assistant histories as this product does. | Reuse observability concepts, but do not conflate instrumented LLM traces with coding-session history. |
| **OpenRappter Flight Recorder** | Local provider-neutral execution ledger with correlated traces and privacy-safe default payload handling. | Treat explicit Flight exports as an adapter input; do not duplicate execution tracing. |
| **OpenRappter Show-and-Tell** | Consent-gated capture of one demonstrated workflow, deterministic analysis, separate approval, then optional skill/disabled-automation build. | Do not add a build phase. Clever Girl detects repeated history; Show-and-Tell owns deliberate demonstration and promotion artifacts. |
| **Fable5 Pass** | Human-led usage audit plus code review, agentic-OS scaffold, generated skills, and safe automation stubs. | Clever Girl productizes only deterministic observation. Fable5 may consume a proposal later under a new explicit request. |

### Primary sources

1. [GitHub — About Copilot CLI session data](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
2. [GitHub — Using `/chronicle`](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
3. [GitHub changelog — Chronicle across agent sessions](https://github.blog/changelog/2026-06-02-gain-insights-across-your-agent-sessions-with-chronicle/)
4. [OpenAI Codex Memories pipeline](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)
5. [SpecStory Lore](https://github.com/specstoryai/getspecstory/tree/main/lore)
6. [`session-analytics`](https://github.com/shihchengwei-lab/session-analytics)
7. [`meta-cc`](https://github.com/yaleh/meta-cc)
8. [`sessiongrep`](https://github.com/braincompany/sessiongrep)
9. [Claude Code History Viewer repository](https://github.com/jhlee0409/claude-code-history-viewer)
10. [OpenRappter Flight Recorder](../../docs/flight-recorder.md)
11. [OpenRappter Show-and-Tell](../../docs/show-and-tell.md)
12. [Fable5 Pass skill](../../.claude/skills/fable5-pass/SKILL.md)

Claims in the table are limited to those source descriptions. Market presence
does not prove quality, adoption, or a defensible moat.

## Minimum lovable scope

The **entire** minimum lovable product is:

1. One command:
   ```bash
   node scripts/rapter-clever-girl.mjs observe \
     --input <explicit path> \
     --skills-root .claude/skills \
     --pretty
   ```
2. Five explicit adapter families: Claude JSONL, Codex JSONL, Copilot export
   JSONL, OpenRappter Flight JSON, and normalized JSONL.
3. Deterministic local normalization and mining; no model, network, or
   subprocess execution by the observer.
4. Versioned `rapter-clever-girl.observe.v2` JSON on stdout by default.
5. Pseudonymous evidence using source digests, session aliases, record
   ordinals, days, and detector rule IDs—not raw text.
6. Existing-capability collision checks over explicit `--skills-root`,
   `--estate-manifest`, and `--capability-catalog` paths.
7. Conservative `capped-active-intervals-v1` lower/upper ranges with a
   300-second gap cap and visible confidence.
8. Optional explicit repository-activity corroboration that cannot create
   session demand.
9. Explicit exclusions for bare controls, weak evidence, intentional
   verification loops, duplicates, candidate/evidence caps, and bounded work.
10. No more than five inert proposals, each with evidence breadth,
   classification, collision result, and false-positive risks.
11. Explicit per-source/context `ok`/`partial`/`failed` reporting and
    diagnostics.
12. No apply, creation, install, enable, watch, or schedule path.

Nothing else is required for the GO.

## Exact kill criteria

The product is **NO-GO** if any one of these conditions becomes true:

| ID | Kill condition |
|---|---|
| K1 | Any report field or diagnostic exposes a raw prompt, response, tool argument, tool output, absolute path, or assistant-native person/repository/session identifier. |
| K2 | Transcript text can alter detector instructions, execute a command, select a tool, change a path, or otherwise act as control input rather than inert data. |
| K3 | The observer makes a network/model call or executes a subprocess while reading, normalizing, redacting, mining, or collision-checking. |
| K4 | The product discovers history implicitly, watches directories, runs in the background, creates a hook, or schedules itself. |
| K5 | Observe Mode mutates a repository/history source/skill/hook/schedule/automation, or exposes any apply/create/install/enable action. The only permitted write is an explicitly supplied `--output` report. |
| K6 | Output contains more than five candidates, accepts a one-occurrence or one-session pattern as a candidate, or silently weakens the requested evidence thresholds. |
| K7 | Output presents a point productivity, ROI, financial-value, benefit, or token-efficiency score, or converts active-friction ranges into a causal forecast. |
| K8 | Scope adds a standalone UI, transcript viewer/search/summarizer, reusable-prompt editor, generic generator, or memory/mirror system. |
| K9 | A candidate can recommend a new capability without checking every explicitly supplied skills root and reporting a reuse/extend/overlap result when found. |
| K10 | A partial or failed source, skipped record count, unavailable friction estimate, or detector failure is omitted or presented as success. |
| K11 | The default writes anywhere other than stdout, or an output path is inferred rather than explicitly provided. |
| K12 | Bare `continue` or another semantically empty control message is promoted as a recurring workflow. |

These are release gates, not roadmap suggestions.

## Acceptance gate

Conditional GO becomes release GO only when evidence shows:

- the committed v2 contract validates representative reports;
- all five adapters have a valid fixture and a malformed/partial fixture;
- a prompt-injection transcript remains inert;
- raw prompts, outputs, paths, and identifiers do not appear in reports;
- default invocation writes only stdout;
- explicit `--output` writes only the named path;
- multiple supplied skills roots produce deterministic collision results;
- defaults require three sessions and two active days;
- candidates have at least two occurrences and two evidence references;
- candidate count never exceeds five;
- active-friction gaps never contribute more than 300 seconds;
- bare `continue` and intentional test/review loops are excluded;
- a partially parseable source yields visible `partial` status and diagnostics;
- no code path applies or creates a skill or automation.

If a check cannot be measured, the gate fails; it is not skipped.

The executable gate is:

```bash
node scripts/rapter-clever-girl-gate.mjs
```

It runs the adversarial fixture suite and requires controlled mutations of the
control-message detector, private output mode, and source-symlink refusal to
turn the suite red.

## Measured fresh-fixture and dogfood results

The fresh fictional fixture spans all five adapters and includes seeded
secrets, paths, prompt injection, malformed records, intentional verification,
negative controls, repeated setup repair, repeated release review, and seven
bare `continue` prompts.

- **41/41 adversarial tests passed.**
- **14/14 acceptance-gate checks passed.**
- Pull-request CI and release preflight both fail hard on the acceptance gate.
- Controlled mutations of control-message exclusion, POSIX `0600` output mode,
  source-symlink refusal, opened-file identity, candidate cap, and active-gap
  cap each made the suite fail.
- Draft 2020-12 validation accepts representative `ok`, `partial`, `failed`,
  and committed dogfood reports and rejects an undeclared report field.
- Twenty clean runs were byte-identical.

The private minimized Copilot run used 13 selected turns from 11 sessions and
is not retained. Its red-green classifier outcome is reproduced by the
committed, wholly redacted 13-turn ledger:

| Measurement | Before classifier refinement | After refinement |
|---|---:|---:|
| Setup/repair candidate | Missed | High confidence, 3 sessions / 3 days, `root-cause-fix` |
| Release-review candidate | 4 sessions, including one deployment false positive | 3 sessions / 2 days, `reuse-existing` → `release-reviewer` |
| Bare `continue` prompts | 7 excluded | 7 excluded |
| Raw text in report | 0 | 0 |
| Explicit POSIX output mode | Not measured | `0600`, no-clobber, byte-identical to stdout |

The committed benchmark command is:

```bash
node scripts/rapter-clever-girl-benchmark.mjs \
  --runs 20 \
  --input fable5/reports/rapter-clever-girl-dogfood-input.jsonl \
  --source copilot \
  --skills-root .claude/skills
```

Under Node v25.2.0 on darwin/arm64 it measured **50.4 ms median**, **53.0 ms
p95**, and **53.2 ms maximum**, with byte-identical compact output and SHA-256
`122add3d6ce0c53693c4124eee956e3a455e90029b7fe459839fda929846e996`.
Because the redacted ledger intentionally keeps only one evidence event per
session, the active-friction range is unavailable. That is the correct
fail-honest result, not a missing success metric.

The privacy-safe machine report is
[`rapter-clever-girl-dogfood.json`](rapter-clever-girl-dogfood.json). Its
`sourceDigest` exactly matches the adjacent
[`rapter-clever-girl-dogfood-input.jsonl`](rapter-clever-girl-dogfood-input.jsonl),
and the gate regenerates and compares the report. The pretty report SHA-256 is
`e02171a509e86c79ad434cb9b5fa4b35e0d747561339fe23584910fcc0c1d828`;
the recorded benchmark is
[`rapter-clever-girl-benchmark.json`](rapter-clever-girl-benchmark.json).

## Evidence-backed promotion candidates

The combined session and repository audit ranks one candidate per scope:

1. **Highest overall repository candidate:** a protected, exact-head
   `openrappter-merge-gate`. The repository window contained eight merges with
   failed checks, three merges before checks completed, and a conservative
   10.8-hour human-triage floor across 130 failing SHAs.
2. **Highest personal workflow candidate:** Frontier/Brainstem First-Run
   Doctor, based on repeated setup/recovery sessions.

Both remain inert Observe Mode findings. See the
[repository activity audit](repository-activity-audit-2026-08-21.md) for the
repository evidence.

The session-history audit ranks **Frontier/Brainstem First-Run Doctor** first
within personal workflow candidates: eight
setup/recovery sessions and approximately 200 manually estimated avoidable
active minutes. The estimate is audit context only. Observe Mode must recompute
and report a range from active intervals rather than emit that point estimate.

Promotion, if separately approved, should target a root-cause/first-run doctor
workflow that distinguishes failed silence from healthy quiet and covers
Windows setup. It should not become a watcher or self-healing scheduler.

Structured release review is not a new-skill candidate: reuse or extend
`release-reviewer`. Exact bare `continue` messages are excluded.

See [the full 30-day audit](usage-audit-2026-08-21.md).

## Decision

**GO** — ship the minimum lovable Observe Mode with the existing scope and kill
criteria intact.

**Automatic NO-GO** — any proposal to add an apply path, raw transcript view,
score, watcher/scheduler, generic generator, standalone viewer, or sixth
candidate belongs to a different product and must not ride this contract.
