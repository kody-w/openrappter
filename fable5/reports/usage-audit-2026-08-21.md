# 30-Day Coding-Assistant Usage Audit

> Audit window: 2026-07-23 through 2026-08-21. Prepared 2026-08-21 for
> Rapter Clever Girl Observe Mode productization.

## Evidence base

The time-bounded session-store audit snapshot contains:

- **52 Copilot CLI sessions**
- **993 user-side turn records**
- **15 identified repository contexts**

The counts below are manual audit groupings, not disjoint telemetry buckets;
one session can carry more than one workflow signal.

| Observed workload | Sessions/briefs | Conservative manually estimated avoidable active minutes |
|---|---:|---:|
| Frontier/Brainstem setup and recovery | 8 sessions | ~200 |
| Engineering delivery | 11 sessions | ~132 |
| Structured reviewer briefs | 10 briefs | ~80 |
| Exact bare `continue` control messages | 7 messages across 5 sessions | Excluded |

The audit used read-only, 30-day-bounded queries over Copilot session and turn
records. Session summaries supplied the 52-session and 15-context coverage;
time-ordered user turns supplied the 993-record total, exact control count,
and workflow examples. Scheduled prompts and delegated reviewer briefs were
not treated as 993 independent human interventions. No raw query result or
transcript is committed. The machine dogfood report preserves only a source
digest, aliases, ordinals, dates, and aggregate counts.

These minute values are manual audit estimates made from reviewed activity.
They are not detector output and should not be used as causal or productivity
claims. Clever Girl reports **observed active-friction lower/upper ranges**
using `capped-active-intervals-v1`, with each contributing gap capped at 300
seconds, instead of carrying these manual point estimates into a product
report.

## Ranked candidates

### 1. Frontier/Brainstem First-Run Doctor — first promotion candidate

**Evidence:** eight setup/recovery sessions and approximately 200 manually
estimated avoidable active minutes. The reviewed corrections repeatedly asked
for first-run Windows reliability, reported that the Frontier/Brainstem path
still failed on Windows, and clarified that silent output could represent a
dead workflow rather than healthy quiet. Exact transcript wording was
consulted during the private audit but is not retained here.

**Recommended classification:** `root-cause-fix` / `workflow-fix`, with a
promotion candidate named **Frontier/Brainstem First-Run Doctor**.

**Why first:** the pattern is repeated, cross-session, concrete, and tied to a
specific outcome: first-run diagnosis that distinguishes healthy quiet from
failed/silent and gives Windows-specific recovery evidence. Promotion should
prefer fixing setup and providing an explicit doctor path over automating
retries or adding a watcher.

**Minimum promotion proof:**

1. Reproduce at least the Windows failures represented by the audited sessions.
2. Define deterministic checks for prerequisites, install/build, startup,
   liveness, and actionable failure output.
3. Prove “silent but healthy” and “silent because dead” produce different,
   testable statuses.
4. Run without background watching, self-healing loops, or hidden mutation.
5. Re-run Observe Mode after release and verify the setup/recovery pattern
   decreases without converting absence into a benefit claim.

### 2. Traceable engineering delivery — extend before inventing

**Evidence:** 11 engineering delivery sessions and approximately 132 manually
estimated avoidable active minutes.

**Recommended classification:** `extend-existing` pending collision review.
The likely overlaps are Fable5's delivery scaffold, Flight Recorder's trace
evidence, and Show-and-Tell's explicit demonstration-to-artifact lifecycle.

The recurring unit is not “write code faster.” It is the traceable sequence
from use case to issue/plan, implementation, validation, and delivery. The
audit includes a governance correction requiring an issue that states the use
case before repository changes, preserving issue-to-fix traceability.

This is a policy boundary, not evidence for an autonomous delivery
automation. A promoted extension must make issue-first behavior explicit,
retain repository scoping, and preserve user-controlled commit/PR decisions.

### 3. Structured release review — reuse/extend `release-reviewer`

**Evidence:** 10 structured reviewer briefs and approximately 80 manually
estimated avoidable active minutes.

**Recommended classification:** `reuse-existing` or `extend-existing`, not a
new skill. The existing
[`release-reviewer`](../../.claude/skills/release-reviewer/SKILL.md) already
encodes read-only review, a claim ledger, evidence counts, adversarial
auth/replay/race/cost-storm/regression checks, and GO/NO-GO output.

The next action is to parameterize or clarify that capability only where the
10 briefs contain requirements it does not cover. Creating another reviewer
would increase collision and drift.

### 4. Recurring correction rules — root cause or instructions, not automation

Three redacted correction themes strengthen the First-Run Doctor candidate:
first-run Windows reliability, a repeated Windows failure after prior repair,
and silent behavior that masked a dead workflow. A fourth is a repository
workflow policy: issue-first traceability before changes. Corrections should be
routed to root-cause fixes or existing instruction surfaces when evidence
breadth supports them; their mere presence does not justify a new skill.

## Explicit exclusion: bare `continue`

The audit found **7 exact `continue` messages across 5 sessions**. Clever Girl
must classify these as control messages and exclude them. The token identifies
neither a reusable task nor an intended outcome; treating it as a recurring
workflow would manufacture a false candidate from interaction mechanics.

Longer continuation prompts remain eligible only when a deterministic detector
finds independent workflow evidence. The exact bare form is not evidence.

## Candidate order

| Rank | Candidate | Decision |
|---:|---|---|
| 1 | Frontier/Brainstem First-Run Doctor | **First human-controlled promotion candidate**; root-cause/workflow fix |
| 2 | Traceable engineering delivery | Collision-check and extend existing delivery/evidence capabilities |
| 3 | Structured release review | Reuse/extend `release-reviewer`; do not duplicate |
| 4 | Recurring correction rules | Route to fixes/instructions when repeated; insufficient alone |
| — | Bare `continue` | Excluded control message |

## What this audit does not claim

- The manual minute estimates are not emitted by Clever Girl.
- A repeated sequence is not proof that automation is safe.
- More turns do not imply lower productivity.
- Fewer future occurrences would not, by itself, prove causality.
- Session counts do not authorize reading any additional history path.
- This report does not approve, create, or schedule the First-Run Doctor.

The first promotion decision belongs to a separate review that can inspect
evidence, permissions, implementation, and tests. Observe Mode stops at the
ranked inert proposal.
