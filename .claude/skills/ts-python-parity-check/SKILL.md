---
name: ts-python-parity-check
description: Cross-checks an OpenRappter module's TypeScript and Python mirror implementations (BasicAgent, ShellAgent, broadcast, router, chain, graph, etc.) for public-API and behavioral divergence, confirms parity tests cover the change, and emits a structured parity report. Use WHEN you edit an agent module in one language, or the user asks whether the Python side matches, to "keep parity," or to check TS↔Python parity before merging.
---

# TS ↔ Python Parity Check

OpenRappter ships parallel TypeScript and Python implementations that are meant to mirror each other exactly. `CLAUDE.md` makes TS↔Python parity a **core invariant** with an explicit file-pair mapping and dedicated parity test directories. This skill is the repeatable gate: given a module, it diffs the two implementations, flags divergences, and verifies the parity test suites cover the change.

## When to run this

- You (or the user) edited an agent module in **one** language and need the other side to match.
- The user asks: "does the Python side match?", "keep parity", "check TS→Python parity before merging", or "run the parity gate".
- Before opening/merging a PR that touches any file in the parity mapping below.

If the request names a specific module (e.g. "check broadcast parity"), scope to that pair. If it's open-ended ("is the branch at parity?"), derive the set of touched pairs from `git status` (step 1).

## File-pair mapping (source of truth)

All paths relative to repo root `/Users/rapptertwo/Documents/GitHub/openrappter`.

| Module        | TypeScript                                  | Python                                             | TS parity test                                        | Python parity test                          |
|---------------|---------------------------------------------|----------------------------------------------------|-------------------------------------------------------|---------------------------------------------|
| BasicAgent    | `typescript/src/agents/BasicAgent.ts`       | `python/openrappter/agents/basic_agent.py`         | `typescript/src/__tests__/parity/data-sloshing.test.ts` | `python/tests/test_basic_agent.py`         |
| ShellAgent    | `typescript/src/agents/ShellAgent.ts`       | `python/openrappter/agents/shell_agent.py`         | `typescript/src/agents/ShellAgent.test.ts`            | `python/tests/test_shell_agent.py`          |
| LearnNewAgent | `typescript/src/agents/LearnNewAgent.ts`    | `python/openrappter/agents/learn_new_agent.py`     | `typescript/src/__tests__/parity/learn-new-agent.test.ts` | `python/tests/test_learn_new_agent.py`  |
| broadcast     | `typescript/src/agents/broadcast.ts`        | `python/openrappter/agents/broadcast.py`           | `typescript/src/__tests__/parity/multiagent.test.ts`  | `python/tests/test_broadcast.py`            |
| router        | `typescript/src/agents/router.ts`           | `python/openrappter/agents/router.py`              | `typescript/src/__tests__/parity/multiagent.test.ts`  | `python/tests/test_router.py`               |
| subagent      | `typescript/src/agents/subagent.ts`         | `python/openrappter/agents/subagent.py`            | `typescript/src/__tests__/parity/multiagent.test.ts`  | `python/tests/test_subagent.py`             |
| chain         | `typescript/src/agents/chain.ts`            | `python/openrappter/agents/chain.py`               | `typescript/src/__tests__/parity/agent-chain.test.ts` | `python/tests/test_agent_chain.py`          |
| graph         | `typescript/src/agents/graph.ts`            | `python/openrappter/agents/graph.py`               | `typescript/src/__tests__/parity/agent-graph.test.ts` | `python/tests/test_agent_graph.py`          |
| tracer        | `typescript/src/agents/tracer.ts`           | `python/openrappter/agents/tracer.py`              | `typescript/src/__tests__/parity/agent-tracer.test.ts`| `python/tests/test_agent_tracer.py`         |
| pipeline      | `typescript/src/agents/PipelineAgent.ts`    | `python/openrappter/agents/pipeline_agent.py`      | `typescript/src/__tests__/parity/pipeline.test.ts`    | `python/tests/test_pipeline.py`             |
| git_agent     | `typescript/src/agents/GitAgent.ts`         | `python/openrappter/agents/git_agent.py`           | `typescript/src/__tests__/parity/git-agent.test.ts`   | `python/tests/test_git_agent.py`            |
| code_review   | `typescript/src/agents/CodeReviewAgent.ts`  | `python/openrappter/agents/code_review_agent.py`   | `typescript/src/__tests__/parity/code-review.test.ts` | `python/tests/test_code_review.py`          |
| web_agent     | `typescript/src/agents/WebAgent.ts`         | `python/openrappter/agents/web_agent.py`           | `typescript/src/__tests__/parity/tool-agents.test.ts` | `python/tests/test_web_agent.py`            |
| clawhub       | `typescript/src/clawhub.ts`                 | `python/openrappter/clawhub.py`                    | `typescript/src/__tests__/parity/skills.test.ts`      | `python/tests/test_module_exports.py`       |

Notes:
- The Memory agent splits in Python: `context_memory_agent.py` + `manage_memory_agent.py` mirror one TS `MemoryAgent.ts`. Treat both Python files as the pair. Python parity test: `python/tests/test_memory_agents.py`.
- If a filename isn't listed, resolve it by convention: TS `CamelCase.ts` ⇔ Python `snake_case.py`; multi-agent primitives (`broadcast`/`router`/`subagent`/`chain`/`graph`/`tracer`) keep their lowercase names in both languages.
- If a pair genuinely has no Python counterpart yet (e.g. `OuroborosAgent`, `WatchmakerAgent`, gateway/UI), say so explicitly in the report — that's a real divergence to flag, not a silent pass.

## Procedure

### 1. Determine scope
- If the user named a module, look it up in the mapping.
- Otherwise run `git status --porcelain` and `git diff --name-only main...HEAD` from the repo root. For every changed path, map it to its pair via the table. Build a deduplicated list of `{module, ts_file, py_file, ts_test, py_test}` tuples. Report which side changed (TS-only, Py-only, or both).

### 2. Read both implementations
For each module in scope, `Read` the TS file and the Python file in full. Do not diff line-by-line as text — the languages differ syntactically. Instead extract each side's **public contract**:

- **Exported/public symbols**: TS `export class|function|interface|type|const`; Python top-level `class`/`def` and `__all__`. Private helpers are TS `#`/unexported or Python `_`-prefixed — parity is about the *public* surface.
- **Class + method signatures**: names, parameter names/order, defaults, return shape.
- **Agent metadata** (for `BasicAgent` subclasses): `name`, `description`, and especially `parameters.properties` + `required` — these must match key-for-key across languages because they define the MCP tool schema.
- **Action verbs and keyword parsing**: e.g. ShellAgent's `bash`/`read`/`write`/`list`; LearnNewAgent's `create`/`list`/`delete`; broadcast modes `all`/`race`/`fallback`.
- **Data-slush / slush keys**: any string keys written into `data_slush`, `upstream_slush`, or `last_data_slush`/`lastDataSlush` must be identical strings.
- **Behavioral constants**: depth limits, timeout defaults, thresholds, error message shapes, ordering (topological/priority) rules.

Fast symbol survey (optional, then confirm by reading):
```bash
# from repo root
grep -nE "export (class|function|interface|type|const)|^\s*(public |private |async )?\w+\(" typescript/src/agents/broadcast.ts
grep -nE "^\s*(class |def |async def )|__all__" python/openrappter/agents/broadcast.py
```

### 3. Diff the contract and classify divergences
Produce a symbol-by-symbol comparison. Classify each finding:

- **API divergence** — a public symbol, method, parameter, default, or metadata field exists on one side but not the other, or differs in name/order/type. (Blocking.)
- **Behavioral divergence** — same surface, different behavior: different default value, threshold, ordering, error string, slush key, or control flow. (Blocking.)
- **Idiomatic difference** — expected language-idiom gaps that are NOT divergences: `async`/`await` vs Python coroutines, `camelCase` (TS) vs `snake_case` (Python) for *local* identifiers, `Map`/`Record` vs `dict`, `Promise.all` vs `asyncio.gather`, factory-pattern ESM (`.js`) generation vs direct Python imports in LearnNewAgent, `#private` vs `_private`. Note them as "expected idiom" so a reviewer sees they were considered, not missed.

Key naming rule: **public method/field names cross the boundary as-is where they're part of the contract** (e.g. `createGroup`↔`create_group` is the expected snake/camel mapping, but the *slush key strings*, metadata property names, and action verbs must be byte-identical). When unsure whether a name is contract or local, check whether the parity test asserts on it.

### 4. Confirm parity tests cover the change
For each module, `Read` both parity test files and verify the changed behavior is actually asserted on **both** sides:
- Does a test exercise the new/changed method, parameter, action, or slush key?
- Are the assertions equivalent across TS and Python (same inputs → same expected outputs/ordering)?
- If the change added a metadata parameter or action verb, is there a test asserting it exists in *both* schemas?

If coverage is missing on either side, that is a report finding: "parity test gap — <module> <behavior> asserted in TS but not Python" (or vice versa).

### 5. Run both suites
Run the scoped tests (not the whole repo) and capture pass/fail. Use absolute-safe invocations:

TypeScript (Vitest):
```bash
# single parity file
cd typescript && npx vitest run src/__tests__/parity/agent-chain.test.ts
# or the co-located agent test
cd typescript && npx vitest run src/agents/ShellAgent.test.ts
```

Python (pytest, config is `python/pyproject.toml` → `[tool.pytest.ini_options] testpaths = ["tests"]`):
```bash
cd python && python3 -m pytest tests/test_agent_chain.py -q
# scope to specific tests
cd python && python3 -m pytest tests/test_broadcast.py -q -k race
```

Notes:
- `cd` inside a single compound command is fine; the working directory does not persist between separate Bash calls, so always `cd` within the same command.
- If `npx vitest`/`pytest` isn't installed, report that (`npm install` in `typescript/`, `pip install -e '.[dev]'` in `python/`) rather than silently skipping — a skipped suite is not a pass.
- If a run fails to import/compile, capture the first error; that is itself a parity-relevant finding.

### 6. Emit the structured parity report
Return this exact structure (Markdown) as your final message — do not write it to a file:

```
# Parity Report: <module(s)>

## Scope
- Modules checked: <list>
- Changed side: <TS-only | Py-only | both> per module
- Pairs: <ts_file> ⇔ <py_file>

## API Parity
| Symbol | TypeScript | Python | Status |
|--------|-----------|--------|--------|
| createGroup / create_group | ✅ | ✅ | match |
| broadcast(groupId,message,executor) | ✅ | ✅ | match |
| <new param X> | ✅ | ❌ missing | DIVERGENCE |

## Behavioral Parity
- <finding or "no divergences">   (default values, thresholds, ordering, slush keys, error strings)

## Expected Idiomatic Differences (not divergences)
- <e.g. Promise.all ⇔ asyncio.gather; camelCase locals ⇔ snake_case>

## Test Coverage
- TS: <file> — <n passed / covers change? yes/no>
- Py: <file> — <n passed / covers change? yes/no>
- Gaps: <list or "none">

## Test Run Results
- TS: <PASS/FAIL> (<command>)
- Py: <PASS/FAIL> (<command>)

## Verdict
PARITY OK ✅  |  DIVERGENCE ❌ — <one-line summary>

## Recommended Fixes (if DIVERGENCE)
1. <concrete edit to the lagging file, with path>
2. <test to add/mirror, with path>
```

## Guardrails

- **Report first, edit only if asked.** By default this skill *diagnoses* and reports. Do not modify either implementation unless the user asked you to fix/sync parity. If they did, edit the lagging file to match the reference side, then re-run step 5 for both languages and update the verdict.
- **Never "fix" parity by weakening the reference side.** Bring the lagging implementation up to the intended contract; don't delete a method from the ahead side to force a match.
- **Public contract only.** Do not flag unexported helpers, `_private`/`#private` methods, or pure language idioms (async syntax, dict vs Map, snake vs camel for locals) as divergences. Flagging noise erodes trust in the gate.
- **Slush keys, metadata property names, and action verbs are byte-exact.** These are the interop contract (MCP schema + `data_slush` chaining). A single renamed key is a real divergence even if behavior "works."
- **A skipped or failing suite is never a pass.** If either suite can't run, the verdict is at best "UNKNOWN — <reason>", never "PARITY OK".
- **Don't touch the main worktree or other worktrees.** Stay in the current working directory per repo worktree etiquette. Ignore `.claude/worktrees/` and `openclaw/` submodule drift in `git status`.
- **No new report files.** Return the report as your message; do not create `.md` files.
- **Missing counterpart ≠ silent pass.** If a module exists in TS but has no Python mirror (e.g. `OuroborosAgent`, `WatchmakerAgent`, gateway/UI/MCP), state that as an explicit divergence/limitation in the report.
