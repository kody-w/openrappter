# 30-Day OpenRappter Repository Activity Audit

> Audit window: 2026-07-23 through 2026-08-21 UTC. Read-only GitHub and local
> git analysis for Rapter Clever Girl Observe Mode.

## Activity snapshot

| Measure | Result |
|---|---:|
| Pull requests opened | 295 |
| Pull requests merged | 289 |
| Median / p90 time to merge | 8.95 / 20.62 minutes |
| Default-branch commits | 437 |
| Formal GitHub reviews | 0 |
| Pull-request comments | 35 across 26 PRs |
| Actions runs | 3,141 |
| Successful / failed runs | 2,689 / 207 |
| Cancelled / skipped runs | 53 / 192 |

All 295 opened PRs were authored by `kody-w`. Corrective work dominated:

- 183/295 PR titles (62.0%) began with `fix:`;
- another 38 were test-focused;
- 247/437 default-branch commits (56.5%) were fixes;
- gateway appeared in 40 PR titles, parity in 11, and Flight Recorder in nine.

The repository had no ruleset or `main` branch protection during the window.
Of 289 merges, eight retained failed checks and three merged before checks
completed. No PR received a formal GitHub review.

The most consequential example is [#49](https://github.com/kody-w/openrappter/pull/49),
merged as [`0fbd12d`](https://github.com/kody-w/openrappter/commit/0fbd12df9792e3f669097f21fd6ada5ea798b9c2)
with five failed jobs. Its resulting `main` commit still failed
[CI](https://github.com/kody-w/openrappter/actions/runs/30877367191),
[conformance](https://github.com/kody-w/openrappter/actions/runs/30877367212),
and [install smoke](https://github.com/kody-w/openrappter/actions/runs/30877367224).

## Repeated correction patterns

- [#181](https://github.com/kody-w/openrappter/pull/181) exposed client/gateway
  RPC drift and was followed immediately by corrections
  [#182](https://github.com/kody-w/openrappter/pull/182),
  [#183](https://github.com/kody-w/openrappter/pull/183),
  [#184](https://github.com/kody-w/openrappter/pull/184),
  [#185](https://github.com/kody-w/openrappter/pull/185), and
  [#188](https://github.com/kody-w/openrappter/pull/188).
- Parity coverage required repeated repair rounds in
  [#210](https://github.com/kody-w/openrappter/pull/210),
  [#213](https://github.com/kody-w/openrappter/pull/213),
  [#224](https://github.com/kody-w/openrappter/pull/224), and
  [#234-237](https://github.com/kody-w/openrappter/pull/234).
- Installer run
  [32108264593](https://github.com/kody-w/openrappter/actions/runs/32108264593)
  exposed mirrored installers drifting. [#277](https://github.com/kody-w/openrappter/pull/277)
  expanded synchronization coverage; its subsequent
  [CI](https://github.com/kody-w/openrappter/actions/runs/32110576941),
  [conformance](https://github.com/kody-w/openrappter/actions/runs/32110576949),
  and [install](https://github.com/kody-w/openrappter/actions/runs/32110577028)
  runs passed.
- [#405](https://github.com/kody-w/openrappter/pull/405) retracted five
  fabricated review findings and added a citation gate.

PR bodies also repeated validation already represented in CI:

| Validation | PRs mentioning it |
|---|---:|
| `tsc --noEmit` | 130 |
| `parity_harness.py` | 54 |
| `conformance.py` | 44 |
| ESLint | 50 |
| Vitest | 33 |

## CI and release friction

The 207 failed Actions runs covered 130 distinct SHAs. The largest sources were
CI (71), rapp-conformance (56), Flight Recorder (25), Install Smoke (22),
Show-and-Tell (11), and Electron Desktop (eight).

Observed retry loops included ten Flight Recorder failures from
[31720590275](https://github.com/kody-w/openrappter/actions/runs/31720590275)
through
[31725551415](https://github.com/kody-w/openrappter/actions/runs/31725551415),
plus two separate five-failure Show-and-Tell sequences.

Both package-release runs failed:

- `v1.11.0` [run 31447657700](https://github.com/kody-w/openrappter/actions/runs/31447657700)
  failed deterministic preflight, yet the GitHub release was published six
  seconds before the workflow failure.
- `v1.12.0` [run 31726549604](https://github.com/kody-w/openrappter/actions/runs/31726549604)
  failed during PyPI OIDC publication; no GitHub release was observed.

Aggregate Actions elapsed time was 175.78 hours, including 17.48 hours in
failed runs. At only five minutes of human triage for each distinct failing
SHA, the conservative floor is **10.8 hours**. This excludes implementation,
review, reruns, and release recovery.

## Highest-value repository candidate

**Candidate:** one protected, exact-head `openrappter-merge-gate`.

It would aggregate the existing CI, conformance, Flight Recorder, installer,
Show-and-Tell, Electron, and security results; become stale after any new
commit; and be required through a `main` ruleset.

This is the highest-impact repository candidate because it closes the observed
path that allowed eight failed and three unfinished PRs to merge without
discarding the substantial validation infrastructure already present.

Under Observe Mode, this is an inert finding. Creating a workflow, changing
branch protection, or enabling a ruleset requires a separate explicit
promotion and approval.

## Combined ranking

| Scope | Candidate | Evidence | Status |
|---|---|---|---|
| Repository-wide | Protected exact-head merge gate | 11 unsafe merges; 10.8-hour conservative triage floor | Highest overall promotion candidate |
| Session workflow | Frontier/Brainstem First-Run Doctor | Eight sessions; approximately 200 manually estimated avoidable minutes | Highest personal workflow candidate |
| Existing capability | Structured release review | Ten repeated reviewer briefs | Reuse or extend `release-reviewer` |

Rapter Clever Girl Observe Mode itself is the delivered workflow-intelligence
product. This report approves none of the downstream candidates.
