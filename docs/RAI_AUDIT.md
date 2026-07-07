# OpenRappter — Responsible AI Audit (pre-submission self-review)

**Purpose:** an honest, reviewer-facing self-audit for a Responsible AI review
submission. It maps OpenRappter to the six Microsoft Responsible AI principles,
states what exists in code today, names the real gaps, and gives each gap a
severity and a concrete remediation. It does not claim the system is
review-ready; it claims to know where it stands.

**System in one line:** a local-first AI agent framework (TypeScript + Python)
that runs single-file agents through an LLM tool-calling loop, with shell
execution, runtime code generation, multi-channel messaging, and a WebSocket
gateway. LLM inference is via GitHub Copilot (Anthropic/OpenAI models) or local
Ollama.

**Audit scope:** the OpenRappter repo (`kody-w/openrappter`). Out of scope:
the RAPP kernel (`kody-w/rapp-installer`) and rapp-spine, which are separate
submissions; the Scout/Clawpilot app, which is Microsoft-owned.

**Overall posture:** the *architecture* is unusually favorable for RAI —
local-first (no data leaves the device except to the model provider),
deterministic orchestration (code coordinates, LLMs only "think"), and an
existing security layer (ApprovalManager, exec-safety injection detection,
audit log, rate limiting, PII stripping). The *gaps* are concentrated in three
places: (1) the runtime code-generation + shell-exec surface, (2) the absence
of model-output content safety, and (3) documentation/transparency artifacts a
reviewer will expect but that don't exist yet.

---

## Risk tiering (Microsoft RAI Impact Assessment framing)

| Dimension | Assessment |
|---|---|
| Autonomy | **High** — agents execute shell commands and generate+load new code at runtime |
| Reversibility | **Mixed** — file/shell operations can be destructive and are not sandboxed |
| Human oversight | **Configurable** — ApprovalManager supports deny/allowlist/full; default is `allowlist` |
| Data sensitivity | **User-controlled** — local memory, messaging channels can carry PII |
| Reach | **Single-user, local** by default; multi-channel + gateway widen it |
| Restricted Uses | Not a restricted MSFT use (no biometric/inference-of-emotion/etc.), but the **dual-use shell+codegen surface** is the load-bearing risk |

**Tier:** treat as a **higher-risk developer tool** — not because of a sensitive
domain, but because it grants an LLM autonomous local code execution.

---

## Principle 1 — Accountability

**In place**
- Audit log of shell command decisions (`security/audit.ts`, `security/exec-safety.ts` `AuditEntry`: cmd, binary, safe, status, timestamp).
- Span-based tracing (`AgentTracer`) records every agent execution with inputs/outputs/duration; dashboard surfaces traces.
- Deterministic orchestration means the decision path is code, not model whim — reviewable and testable (3,100+ TS tests, 660 Python).
- Core agent files are deletion-protected; generated agents are namespaced.

**Gaps**
| Gap | Severity | Remediation |
|---|---|---|
| No single documented "who is accountable / how to report harm" surface | Medium | Add `SECURITY.md` + `RESPONSIBLE_USE.md` with a reporting channel |
| Audit log is per-subsystem, not a unified tamper-evident record | Medium | Consolidate to one append-only audit stream; document retention |
| No model/data card for the shipped default behavior | Medium | Publish a transparency note (see Principle 4) |

## Principle 2 — Transparency

**In place**
- The single-file agent pattern is inherently legible: metadata contract + code in one file, no hidden config.
- `data_slush` / sloshing has a debug mode capturing all pipeline stages; `SloshDebug` exposes what context an agent saw.
- Open source; deterministic demos; extensive inline documentation.

**Gaps**
| Gap | Severity | Remediation |
|---|---|---|
| No user-facing disclosure that outputs are AI-generated / may be wrong | **High** | Add a standing disclosure in CLI/dashboard/channel replies |
| No transparency note documenting intended uses, limitations, model provenance | **High** | Author a Transparency Note (MSFT template) — the top reviewer ask |
| Users may not realize agents can run shell commands / install packages on their machine | **High** | First-run consent screen enumerating capabilities before any exec |
| Capability-scoring (OuroborosAgent) emits confident numeric "quality" scores that are heuristic, not ground truth | Low | Label scores as heuristic in output (partially done via `input_difficulty`) |

## Principle 3 — Fairness

**In place**
- No demographic decisioning, ranking of people, or resource allocation in the core product — fairness surface is narrow by design.
- Deterministic agents (triage, cipher, word-stats) are rule-based and inspectable.
- Capability scoring already encodes fairness-of-measurement principles (graduated thresholds, inclusive boundaries, polarity-agnostic sentiment, `input_difficulty` to separate "capability weak" from "unfair input").

**Gaps**
| Gap | Severity | Remediation |
|---|---|---|
| Sentiment/word heuristics are English-only; non-English input silently scores as "no signal" | Medium | Document the English-only limitation; detect+flag non-English rather than scoring it 0 |
| Any fairness harm would come from the underlying model (Copilot/Anthropic/OpenAI), which OpenRappter passes through untouched | Medium | Document dependence on the provider's fairness posture; link their model cards |
| No evaluation set for disparate agent behavior across dialects/names | Low | Add a small fairness probe suite if agents ever make people-affecting decisions |

## Principle 4 — Reliability & Safety

**In place**
- ApprovalManager: `deny` / `allowlist` / `full` policies, per-channel/agent scoped rules, blocked patterns, request/approve flow (`security/approvals.ts`, 451 lines, tested).
- Exec-safety: shell **injection detection** (ordered pattern set), a default safe-binary allowlist, pending-approval workflow, audit trail (`security/exec-safety.ts`).
- Rate limiting (`security/rate-limiter.ts`).
- SubAgent depth limits + loop detection; soul-to-soul summon cycle + depth guards.
- Self-healing cron with bounded restart logic; graceful degradation (a broken agent file fails that file, not the server).
- Determinism: LLMs think, code coordinates — no autonomous control flow from model output.

**Gaps (the core of this submission)**
| Gap | Severity | Remediation |
|---|---|---|
| **Shell execution is not sandboxed** — an approved command runs with full user privileges | **High** | Document the trust boundary explicitly; offer an opt-in restricted mode (no network / temp-dir cwd / denied-by-default); recommend running under an OS sandbox |
| **Default approval policy is `allowlist`, but the default allowlist includes `curl`, `wget`, `chmod`, `pip`, `npm`** — these are dual-use (arbitrary download+execute) | **High** → *partially closed* | **Mechanism shipped**: `exec-safety.ts` now classifies `DUAL_USE_BINS` and every result carries `dualUse` / `requiresApproval` so an approval layer can gate them; opt-in `strictDefaults` removes them from the auto-safe set entirely. **Remaining human decision**: flip the *shipped* default to strict (a load-bearing behavior change) and wire `requiresApproval` into the exec path |
| **LearnNewAgent generates code and runs `pip install` / `npm install` on inferred dependencies at runtime** — supply-chain + arbitrary-code-execution surface | **High** | Require explicit approval before any install; pin/verify packages; sandbox generated-agent first run; document loudly |
| **No content safety on model output** — no filtering of harmful/unsafe generated text or generated code | **High** | Integrate a content-safety check (Azure AI Content Safety or equivalent) on model outputs and generated agent source before write/exec |
| Prompt-injection via tool results / channel messages can steer the tool loop | **High** | Treat tool/channel content as untrusted; add injection-aware guarding on the loop (XPIA posture); never auto-approve exec triggered by external content |
| Runtime `import()` / `exec_module` of generated agents loads unreviewed code | Medium | Static-scan generated source pre-load; keep generated agents out of the auto-exec path until approved |
| No global kill-switch / "pause all agents" control | Medium | Add a gateway-level halt |

## Principle 5 — Privacy & Security

**In place**
- **Local-first**: memory, config, souls, and agent files live under `~/.openrappter`; nothing is sent anywhere except the chosen model provider.
- PII stripping for messaging (`messaging/pii.ts`) — tokenizes emails, phones, IPs, Apple IDs before content leaves the local boundary; PII map kept local, never published.
- Sealed/encrypted messaging paths; DM pairing + policy; rappter-signal integration tests.
- Filename-safe validation on soul IDs (blocks path traversal); config-shape validation; audit permission checks recommend `chmod 700 ~/.openrappter`.
- Auth token stored locally in the kernel's format; `gho_` tokens rejected; short-lived Copilot session tokens with expiry.

**Gaps**
| Gap | Severity | Remediation |
|---|---|---|
| Conversation/memory content is sent to the model provider (Copilot → Anthropic/OpenAI) — expected, but undisclosed to the user | **High** | Disclose the data flow + provider in a privacy note; link provider data-handling terms |
| `.copilot_token` written to disk as plaintext JSON (mirrors kernel, but still) | Medium | Document; recommend `chmod 600`; consider OS keychain |
| PII stripping is regex-based and English/US-format-biased; misses many PII classes | Medium | Document coverage limits; do not represent it as complete redaction |
| No data-retention / deletion controls documented for local memory | Medium | Document how to inspect/export/delete memory; provide a `memory clear` path (exists in storage; surface it) |
| Gateway auth token lifecycle not documented; a well-known default token (`aether-internal-gateway-token`) appears in the Clawpilot integration path | Medium | Document that the gateway must be run with a generated token; never accept a well-known default on a non-loopback bind |

## Principle 6 — Inclusiveness

**In place**
- Runs locally with no API keys required (Copilot-backed) — lowers cost/access barriers.
- Multi-channel (CLI, Slack, Discord, Telegram, Signal, iMessage, etc.) meets users where they are.
- Dashboard is theme-aware; CLI + web + desktop surfaces.

**Gaps**
| Gap | Severity | Remediation |
|---|---|---|
| No documented accessibility review of the dashboard (contrast, keyboard nav, screen-reader) | Medium | Run an a11y pass on the Lit dashboard; document conformance |
| English-only NLP heuristics (shared with Fairness gap) | Medium | Flag non-English; document supported languages |

---

## Top 8 must-fix before a formal RAI review

Ranked by reviewer-blocking likelihood × severity:

1. **Transparency Note** documenting intended uses, limitations, model provenance, and the shell/codegen capability. *(nothing ships without this)*
2. **First-run capability consent** — the user must affirmatively acknowledge that agents can execute shell commands and install packages before any run.
3. **Stricter default approval policy** — network + install binaries (`curl`, `wget`, `pip`, `npm`, `chmod`) behind explicit approval, not on the default allowlist.
4. **Approval gate on LearnNewAgent installs** and generated-code execution; static-scan generated source before load.
5. **Content safety on model output and generated code** before write/exec.
6. **Prompt-injection / XPIA posture** — external content (tool results, channel messages) is untrusted and can never auto-trigger exec.
7. **Data-flow disclosure** — say plainly that conversation content goes to the model provider; link their terms.
8. **AI-generated-content disclosure** surfaced in every user-facing channel.

## What's genuinely strong (lead with these in the review)

- Local-first data posture — the smallest reasonable data-exfiltration surface.
- Deterministic orchestration — the model never holds the control flow; every branch is code you can test, and 3,700+ tests do.
- A real, tested security layer already exists (approvals, injection detection, audit, rate limiting, PII stripping) — this is a hardening exercise, not a greenfield one.
- The single-file agent contract makes every capability auditable in one place.

---

*Self-audit, not an approval. Prepared for internal RAI submission triage.
Severities are the author's estimate and should be re-scored by the RAI reviewer.*
