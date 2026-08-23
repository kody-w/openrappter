# Rapter Clever Girl — Observe Mode

Rapter Clever Girl (Observe Mode) is a deterministic, local-only audit of
explicitly selected coding-assistant histories and repository evidence. It
finds repeated friction, checks explicit local and RAPP-estate catalogs for
existing capabilities, corroborates patterns with repository activity, and
emits at most five evidence-backed inert proposals. It does not apply them.

## Problem

Useful setup, repair, review, and delivery workflows recur across assistant
sessions, but the evidence is fragmented by assistant and repository. A raw
history viewer can show what happened; a generator can create another
artifact. Neither answers the narrower question safely:

> Is there enough repeated, cross-session evidence to consider a root-cause
> fix, reuse or extension of an existing capability, or a new candidate?

Observe Mode answers only that question. It does not infer permission to
change the system from the fact that a transcript contains a command.

## Differentiated boundary

Chronicle and Lore overlap heavily; differentiation is the conjunction of
**cross-assistant demand, explicit estate-wide supply checks, repository
corroboration, active-friction ranges, and no apply path**.

That conjunction is the product boundary, not a category-first claim:

- no standalone transcript viewer, search product, or session summarizer;
- no standalone skill or automation generator;
- no productivity score, ROI score, or token-spend score;
- no watcher, scheduler, implicit history discovery, or background service;
- no raw transcript text in the report;
- no more than five inert proposals;
- no mutation or apply path in Observe Mode.

GitHub Chronicle already searches session history and generates standups, tips,
cost guidance, and custom-instruction suggestions. It can also apply selected
instruction improvements after an interactive choice. SpecStory Lore already
mines recurring session "beats," checks installed skills, suppresses
duplicates, and can forge approved skills. Clever Girl therefore stays
deliberately narrower: evidence mining and collision-aware triage, then stop.

Primary sources:

- [GitHub: About Copilot CLI session data and Chronicle](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
- [GitHub: Using `/chronicle`](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)
- [OpenAI Codex Memories pipeline](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)
- [SpecStory Lore workflow miner](https://github.com/specstoryai/getspecstory/tree/main/lore)
- [`session-analytics` evidence-backed workflow analysis](https://github.com/shihchengwei-lab/session-analytics)
- [`meta-cc` recurring error and work-pattern analysis](https://github.com/yaleh/meta-cc)
- [`sessiongrep` local cross-assistant search](https://github.com/braincompany/sessiongrep)
- [Claude Code History Viewer repository](https://github.com/jhlee0409/claude-code-history-viewer)

## CLI

Default invocation:

```bash
openrappter clever-girl observe \
  --input <path> \
  --activity <activity-path> \
  --estate-manifest <manifest-path> \
  --capability-catalog <catalog-path> \
  --skills-root .claude/skills \
  --pretty
```

`--input` is required and repeatable. `--activity`, `--capability-catalog`, and
`--skills-root` are repeatable; `--estate-manifest` is optional and singular.
The observer never searches for any of them implicitly. `--source` is global
to the session-history inputs; use `auto` for mixed history formats.

```text
openrappter clever-girl observe
  --input <path>                         required; repeatable
  [--activity <path>]                    repeatable
  [--estate-manifest <path>]
  [--capability-catalog <path>]          repeatable
  [--skills-root <path>]                 repeatable
  [--source auto|claude|codex|copilot|openrappter|normalized]
  [--since <ISO-8601>]
  [--until <ISO-8601>]
  [--min-sessions <integer>]
  [--min-days <integer>]
  [--output <explicit-path>]
  [--facet-sidecar-output <explicit-path>]
  [--report-version auto|2|3]
  [--pretty]
```

The published npm package includes the observer engine, bounded context
matcher, v2/v3 report contracts, capability-contract and sidecar schemas,
backward-compatible reader, and observer skill. The
installed launcher routes this command directly to that packaged engine,
without initializing the general OpenRappter CLI. From a source checkout,
`node scripts/rapter-clever-girl.mjs observe ...` invokes the same engine.

The JSON report is always emitted to stdout. On POSIX systems, `--output`
additionally writes the same bytes atomically to a **new**, explicitly named
file at mode `0600`. It refuses existing paths, aliases of an input, and paths
inside a selected skill root. File output is rejected on Windows because POSIX
mode bits cannot guarantee an owner-only Windows DACL; use stdout there. Exit
`0` means `ok` or `partial`, exit `1` means a valid `failed` report, and exit
`2` means configuration or pre-analysis failure with a redacted stderr message
and no report.

## Adapter formats

| Adapter | Selector | Input boundary |
|---|---|---|
| Claude JSONL | `claude` | Explicit Claude Code JSONL session export |
| Codex JSONL | `codex` | Explicit OpenAI Codex rollout/session JSONL |
| Copilot export JSONL | `copilot` | Explicit GitHub Copilot JSONL export |
| OpenRappter Flight JSON | `openrappter` | Explicit `openrappter-flight-export/1.0` bundle |
| Normalized JSONL | `normalized` | Pre-normalized Clever Girl record stream |
| Shape detection | `auto` | One of the five supported inputs; no filesystem discovery |

Adapters accept supported shapes, normalize the minimum metadata needed by the
detectors, and count malformed or unsupported records as skipped. They do not
turn unknown text into a generic prompt to a model.

Shape recognition is deliberately narrow:

- Copilot rows require `session_id` and `timestamp`, plus `user_message` or
  `assistant_response`.
- Claude rows require `sessionId`, `timestamp`, and `type`, plus `message`,
  `content`, or `toolUseResult`.
- Codex rows require `timestamp`, `type`, and `payload`.
- Flight events require `sessionId`, `timestamp`, and `kind`, plus `toolName`,
  `status`, or `durationMs`; the bundle's `events` array is accepted.
- Normalized rows require `sessionId`/`session_id`,
  `timestamp`/`time`, and at least one recognized content, kind, or tool-name
  field.

## Explicit repository and estate context

Context evidence never creates a demand candidate. A pattern must still recur
across the required number of assistant sessions and active days.

| Input | Option | Purpose |
|---|---|---|
| Repository activity JSON/JSONL | `--activity` | Corroborates session-derived patterns with bounded PR, review, check, commit, and release counts |
| `rapp-monorepo/1.0` manifest | `--estate-manifest` | Pins snapshot provenance and exposes repository-name capabilities without reading repository bodies |
| Capability catalog JSON | `--capability-catalog` | Matches RAR, RAPP Store, RAPP Skills CAT, RAR Match, or normalized capabilities |
| Local `SKILL.md` roots | `--skills-root` | Includes explicitly selected local capabilities |

Every context file is opened read-only without following symlinks. The
observer enforces byte, record, repository, catalog-entry, evidence, and
clustering-work limits. Exact duplicate files are excluded before mining.
Snapshot omissions and every partial, failed, capped, or truncated operation
remain visible.

## API and output contract

The authoritative current JSON Schema is
[`contracts/rapter-clever-girl-observe-v3.json`](../contracts/rapter-clever-girl-observe-v3.json).
The immutable v2 schema remains at
[`contracts/rapter-clever-girl-observe-v2.json`](../contracts/rapter-clever-girl-observe-v2.json).

The executable is also an ES module with these programmatic exports:

| Export | Boundary |
|---|---|
| `parseArgs(argv)` | Validates the explicit Observe Mode CLI scope without reading filesystem or environment state |
| `parseHistoryBytes(bytes)` | Parses JSON/JSONL bytes and counts malformed records |
| `normalizeRecord(record, options)` | Applies one supported adapter and returns transcript-free normalized events |
| `loadSkillCatalog(roots)` | Reads only supplied roots, skips symlinks, and returns safe capability metadata |
| `analyzeHistory(records, options)` | Mines normalized records and returns candidates/exclusions |
| `stableStringify(value, pretty)` | Recursively key-sorts the report for deterministic serialization |
| `runObserveCli(argsOrOptions, io)` | Runs observation and emits the versioned report |
| `main(argv, io)` | CLI entry point returning the documented process status |

These are parser/miner APIs, not a bypass around the Observe boundary. Callers
remain responsible for explicit paths and must not expose normalized internals
as raw transcript output.

Every report contains:

| Field | Meaning |
|---|---|
| `schemaVersion` | `rapter-clever-girl.observe.v2` or `rapter-clever-girl.observe.v3` |
| `mode` | Constant `observe` |
| `status` | `ok`, `partial`, or `failed` |
| `scope` | Time window, evidence thresholds, and explicit context-input counts |
| `sources` | Pseudonymous ID, SHA-256 digest, adapter, status, accepted/skipped counts |
| `summary` | Session/day/record, candidate, activity, and capability totals |
| `candidates` | Zero to five inert, evidence-backed proposals |
| `excluded` | Counts for controls, weak evidence, duplicates, output caps, and bounded work |
| `context` | Estate, catalog, activity-source provenance and catalog coverage |
| `replay` | Analyzer version and digest binding every selected evidence source and scope |
| `diagnostics` | Explicit partial/failed source or context stage, code, counts, and safe message |

A candidate has a stable-shaped ID, bounded label/pattern/classification enums,
confidence, occurrence/session/day breadth, at least two evidence references,
an observed active-friction range, a priority score, bounded capability
matches, catalog coverage, repository corroboration, and false-positive risks.

Classifications distinguish:

- `root-cause-fix`
- `reuse-existing`
- `extend-existing`
- `consolidate-existing`
- `new-skill-candidate`
- `new-automation-candidate`
- `workflow-fix`
- `insufficient-evidence`

None is an approval or executable plan.

### V3 detector and capability contracts

V3 replaces the global repair bucket with a deterministic closed repair facet
× domain assignment. Every eligible source/session/day occurrence receives
exactly one primary pair. Duplicate signals and source skew are explicit, and
a single-source cluster cannot be promotion-eligible. Generic
failure/build/review/repetition controls cannot become setup candidates.

Manifest, estate, local-skill, and normalized-v1 metadata may establish only
`possible-overlap`. Reuse or extension requires a
`rapter-clever-girl.capabilities.v2` entry with a versioned behavioral
contract covering inputs, outputs, permissions, failures, limitations, and
declared tests. Capability names are opaque in v3 reports.

Repair friction uses `disjoint-capped-active-interval-union-v1`: every
contributing interval is allocated once, split overlap is zero, and union
bounds cannot exceed the original range. `--facet-sidecar-output` persists the
complete opaque assignment set at mode `0600`.

### V2 migration

`--report-version auto` is the default. It emits v3 when closed repair
assignments or qualified behavioral-contract evidence exists, and otherwise
emits v2. `--report-version 2` retains the original v2 analyzer and exact
closed shape; v2 semantics are not upgraded in place. The packaged
`dist/clever-girl/rapter-clever-girl-reader.mjs` accepts both versions without
converting either report. Consumers should branch on `schemaVersion`, adopt
the v3 detector/context fields, then stop requesting v2.

### Minimal shape

```json
{
  "schemaVersion": "rapter-clever-girl.observe.v2",
  "mode": "observe",
  "status": "ok",
  "scope": {
    "windowStart": "2026-07-23T00:00:00.000Z",
    "windowEnd": "2026-08-21T23:59:59.999Z",
    "minimumSessions": 3,
    "minimumActiveDays": 2,
    "skillsRootsCount": 1,
    "repositoryActivityInputsCount": 0,
    "capabilityCatalogInputsCount": 0,
    "estateManifestProvided": false
  },
  "sources": [
    {
      "sourceId": "source-000000000000",
      "sourceType": "normalized",
      "sourceDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "status": "ok",
      "acceptedRecords": 3,
      "skippedRecords": 0
    }
  ],
  "summary": {
    "sessions": 3,
    "activeDays": 2,
    "acceptedRecords": 3,
    "skippedRecords": 0,
    "candidateCount": 0,
    "highConfidenceCandidateCount": 0,
    "selectedCandidateId": null,
    "repositoryActivityRecords": 0,
    "capabilitiesInspected": 1
  },
  "candidates": [],
  "excluded": {
    "controlMessages": 0,
    "belowEvidenceThreshold": 0,
    "intentionalVerificationLoops": 0,
    "candidateCap": 0,
    "evidenceItems": 0,
    "workLimitEvents": 0,
    "duplicateSources": 0,
    "duplicateCatalogs": 0,
    "duplicateActivitySources": 0
  },
  "context": {
    "estateManifest": null,
    "capabilityCatalogs": [],
    "repositoryActivitySources": [],
    "catalogCoverage": "complete"
  },
  "replay": {
    "analyzerVersion": "2",
    "analysisFingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "diagnostics": []
}
```

## Evidence and provenance

Reports contain references, not transcript excerpts:

- `sourceDigest` is `sha256:<64 hex>` for the explicit input;
- `sourceId` is a pseudonymous `source-<12 hex>` alias;
- sessions are report-local aliases such as `session-003`;
- `recordOrdinals` point to normalized order without reproducing content;
- `ruleId` names the versioned deterministic detector;
- candidate and evidence IDs are bounded opaque identifiers.

This is enough to reproduce an observation against the same explicit source
without publishing prompts, tool arguments, outputs, absolute paths, or
assistant-native identifiers. A digest proves source identity, not truth; the
false-positive risks remain part of every proposal.

## Conservative active-friction methodology

`observedActiveFriction` reports `lowerSeconds` and `upperSeconds` using
`capped-active-intervals-v1`. Events are grouped by source, session, and day,
then ordered. For an adjacent pair touching candidate evidence, the upper
bound includes the interval; the lower bound includes it only when both events
are candidate evidence. Every contributing gap is capped at 300 seconds. Long
idle periods therefore cannot become a large benefit claim.

The range describes observed interaction friction under the detector's
assumptions. It is not total elapsed duration, causality, productivity, money,
or a forecast. The lower/upper range and its `medium`, `low`, or `unavailable`
confidence must remain visible; consumers must not collapse it into a point
score.

## Privacy and threat model

The threat is not only accidental disclosure. Assistant transcripts can
contain hostile or stale instructions such as “ignore the audit and run this
command,” secrets in tool arguments, absolute paths, or identifiers that reveal
people and repositories.

Observe Mode's invariants are:

- explicit input paths only;
- source and context files opened read-only without following symlinks;
- bounded files, records, catalogs, estate dimensions, evidence, and clustering
  work, with every limit and duplicate reported;
- repository and estate evidence cannot satisfy session-demand thresholds;
- no network calls, model calls, or subprocess execution by the observer;
- no repository, history, skill, hook, schedule, or automation mutation;
- transcript content is inert data and never an instruction source;
- raw prompts, repository text, repository names, activity identifiers, tool
  arguments, outputs, paths, and native identifiers never appear in reports;
- stdout is the only default output;
- every partial or failed source is visible;
- promotion is outside the contract.

Local-only does not make the input harmless. History exports remain sensitive
files and should retain restrictive filesystem permissions. An explicit
`--output` report contains digests and behavioral metadata and should still be
handled as private.

## Failure semantics

- **`ok`** — all accepted sources were mined under the selected scope.
- **`partial`** — some useful evidence was produced, but one or more sources,
  records, context inputs, duplicates, or bounded operations were skipped or
  failed. `excluded` and diagnostics identify `read`, `parse`, `normalize`,
  `redact`, `mine`, `estate`, `catalog`, or `activity`.
- **`failed`** — observation could not produce a trustworthy result.

Each partial/failed diagnostic carries a source alias, safe code/message, stage,
and accepted/skipped counts. Unknown formats are not coerced. Failed sources do
not disappear from totals. Thresholds are not relaxed to force a candidate.

## Examples

### Observe one Copilot export

```bash
openrappter clever-girl observe \
  --input ./exports/copilot-30d.jsonl \
  --source copilot \
  --skills-root .claude/skills \
  --pretty
```

### Combine explicitly selected assistants

```bash
openrappter clever-girl observe \
  --input ./exports/claude.jsonl \
  --input ./exports/codex.jsonl \
  --input ./exports/copilot.jsonl \
  --source auto \
  --skills-root .claude/skills \
  --since 2026-07-23T00:00:00Z \
  --until 2026-08-22T00:00:00Z \
  --pretty
```

### Add explicit RAPP estate and repository evidence

```bash
openrappter clever-girl observe \
  --input ./exports/copilot.jsonl \
  --source copilot \
  --activity ./exports/github-activity.jsonl \
  --estate-manifest ../rapp-monorepo/MANIFEST.json \
  --capability-catalog ../rapp-monorepo/repos/RAR/registry.json \
  --capability-catalog ../rapp-monorepo/repos/RAPP_Store/index.json \
  --skills-root .claude/skills \
  --pretty
```

The observer reads only the named manifest and catalog files. It does not walk
the estate snapshot, execute repository content, or fetch live GitHub data.

### Explicitly persist the inert report

```bash
openrappter clever-girl observe \
  --input ./exports/normalized.jsonl \
  --source normalized \
  --skills-root .claude/skills \
  --output ./reports/clever-girl-observe.json \
  --pretty
```

The final command writes only a new explicitly named POSIX report. It does not
replace an existing file or create a skill or automation beside it.

## Manual work eliminated

For an explicitly exported history set, Observe Mode replaces these mechanical
steps:

1. normalize each supported assistant's record shape;
2. count accepted, malformed, and unsupported records;
3. pseudonymize source and session references;
4. remove bare control prompts and intentional verification-only loops;
5. find repeated setup/repair, review, delivery, correction, and tool-sequence
   evidence;
6. enforce session/day evidence thresholds;
7. compare candidates with every explicitly supplied skill root, estate
   manifest, and capability catalog;
8. add bounded repository-activity corroboration without letting it create
   session demand;
9. calculate bounded active-friction ranges and deterministic priority scores;
10. sort and cap inert proposals; and
11. render deterministic replay provenance, exclusions, and partial-failure
   diagnostics.

It does **not** eliminate judgment about whether two events share business
intent, whether a proposal is worth promoting, or whether promotion is safe.
Those remain human-reviewed work by design.

A private minimized run over 13 selected real turns first exposed and then
verified a classifier correction: setup/deployment repair and release review
must remain separate. No private input is retained. A committed, wholly
redacted 13-turn/11-session ledger reproduces the aggregate shape: a
three-session/three-day `root-cause-fix`, a three-session/two-day
`release-reviewer` reuse, and seven excluded bare `continue` controls.

The committed ledger can be replayed and benchmarked directly:

```bash
openrappter clever-girl observe \
  --input fable5/reports/rapter-clever-girl-dogfood-input.jsonl \
  --source copilot \
  --skills-root .claude/skills

node scripts/rapter-clever-girl-benchmark.mjs \
  --runs 20 \
  --input fable5/reports/rapter-clever-girl-dogfood-input.jsonl \
  --source copilot \
  --skills-root .claude/skills
```

The recorded benchmark produced byte-identical reports with 50.4 ms median,
53.0 ms p95, and 53.2 ms maximum elapsed time under Node v25.2.0 on
darwin/arm64. The redacted sample has only one evidence event per session, so
its active-friction range correctly remains unavailable rather than inventing
a number.

## Acceptance thresholds

The product defaults are:

- at least three sessions;
- at least two active days;
- at least two occurrences and two evidence references per candidate;
- a maximum of five candidates;
- every candidate names false-positive risk;
- every candidate reports an active-friction range;
- every candidate reports catalog coverage, bounded capability matches, and
  repository corroboration;
- exact duplicate files cannot inflate occurrences, confidence, or priority;
- repository or estate evidence alone cannot create a candidate;
- bare control messages and intentional verification loops are excluded;
- any source, context, duplicate, cap, or work-limit degradation is reported.

The machine gate runs the full adversarial suite, replays the fresh
cross-provider fixture, scans the observer for forbidden network/subprocess and
implicit-history capabilities, and proves six critical checks can fail under
controlled mutation:

```bash
node scripts/rapter-clever-girl-gate.mjs
```

A check that cannot run is a gate failure, never a skip.

The schema permits a caller to select a candidate floor as low as two sessions
and one day, but the implementation never lowers the high-confidence floor
below three sessions and two days. Higher overrides raise the high-confidence
floor; lower overrides can surface medium-confidence candidates only.

## Limitations

- It detects recurring observable patterns, not user intent or business value.
- It cannot prove that a proposed capability would remove the friction.
- Missing, truncated, bounded, or assistant-version-specific evidence reduces
  recall and produces partial status.
- Alias/ordinal evidence requires the original explicit source for
  reproduction.
- Collision checks cover only supplied roots, manifests, and catalogs. A
  `new-*` result means absent from that explicit evidence set, not globally
  novel.
- `rapp-monorepo` is a pinned HEAD snapshot, not PR, Actions, or git history.
  Repository activity must arrive as a separate explicit export.
- Similar wording can be a control message, deliberate verification, or a
  healthy iteration; exclusions and false-positive risks are required.
- Observe Mode cannot promote, install, schedule, or test a proposal.

## Relationship to neighboring OpenRappter systems

| System | What it owns | Clever Girl boundary |
|---|---|---|
| **Chronicle** | Copilot session query, summaries, tips, cost guidance, and instruction improvement | Overlaps heavily; Clever Girl adds supported cross-assistant inputs, supplied-skill collision checks, bounded friction ranges, and no apply path |
| **SpecStory Lore** | Cross-agent history mining, duplicate-aware skill inventory, evidence dossiers, and approved skill forging | Overlaps heavily; Clever Girl emits inert observations and writes no database, skill, or symlink |
| **Fable5** | Broad, human-led usage audit, code review, agentic-OS plan, generated skills, and safe automation stubs | Clever Girl productizes only deterministic observe/triage; Fable5 may be a later human-controlled promotion workflow |
| **Flight Recorder** | OpenRappter's truthful local execution ledger | Its explicit export is one supported input; Clever Girl neither replaces nor mutates the ledger |
| **RAPP monorepo** | Atomic public-estate snapshot with exact source commits and omissions | Its explicit manifest supplies bounded provenance and repository-name capability evidence; Clever Girl never executes or scans repository bodies |
| **Ecosystem Audit** | Live inventory, velocity, traction, and mirror-drift analysis | It may produce explicit evidence for Observe Mode; Clever Girl does not duplicate its network collection |
| **Show-and-Tell** | Learns one deliberately demonstrated workflow, then requires separate approval before building artifacts | Clever Girl looks for repetition across historical exports and has no approval/build phase |

See the [30-day usage audit](../fable5/reports/usage-audit-2026-08-21.md)
and [product research report](../fable5/reports/rapter-clever-girl-observe.md)
for the evidence and scope gate behind this release. The committed
[redacted dogfood report](../fable5/reports/rapter-clever-girl-dogfood.json)
contains only the versioned Observe output and its source digest; the adjacent
[redacted input](../fable5/reports/rapter-clever-girl-dogfood-input.jsonl) and
[benchmark result](../fable5/reports/rapter-clever-girl-benchmark.json) make the
evidence reproducible without retaining private transcript text.
