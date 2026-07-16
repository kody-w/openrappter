---
name: claude-md-generator
description: Generate or refresh a high-signal CLAUDE.md tailored to a codebase — dense but navigable, with real build/test commands, architecture sections, key modules, and conventions. Use when the user runs init in a repo, asks to "create/write a CLAUDE.md", says "generate project instructions", or wants an existing CLAUDE.md refreshed after architecture, dependency, or convention changes.
---

# CLAUDE.md Generator

Produce project instructions that a future Claude Code session can actually navigate and trust: the real commands, the real architecture, the real conventions — nothing invented. The target style is the OpenRappter CLAUDE.md: dense, scannable, file-path-anchored, one durable fact per line.

## When to use this skill

- User runs `/init` or says "initialize this repo" / "set up CLAUDE.md".
- User asks to "create", "write", "generate", or "refresh" a CLAUDE.md or "project instructions".
- Architecture, build tooling, or conventions changed and the existing CLAUDE.md is stale.
- A new subproject/package was added that has no coverage in project instructions.

If a CLAUDE.md already exists, **refresh in place** (preserve human-authored prose and philosophy sections) rather than overwriting. Never blow away hand-written guidance.

## Output contract

- Write to `CLAUDE.md` at the repo root (or the nearest package root the user names). Sub-package CLAUDE.md files are fine when a package is large and self-contained.
- Markdown only. No YAML frontmatter in CLAUDE.md itself (frontmatter belongs to skills, not project instructions).
- Open with the standard line so the file is self-identifying:
  `This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.`
- Then a short **project overview** paragraph, then the sections below.

## The house style (non-negotiable)

The user maintains an unusually rich CLAUDE.md and wants every repo to match that shape:

1. **One durable fact per line.** Bullets over paragraphs for anything reference-like (modules, endpoints, commands, file mappings). A reader should find any fact by scanning, not reading.
2. **Anchor every claim to a path.** `` `typescript/src/agents/graph.ts` `` beats "the graph executor". If you name a system, name the file(s). End architecture subsections with a **Files:** line listing sources and their test files.
3. **`## Architecture: <System>` sections** for each major subsystem, each with: what it does (1–2 lines), key types/abstractions, the execution/data flow, and a **Files:** anchor. Mirror the existing headings (`## Architecture: Agent System`, `## Architecture: MCP Server`, etc.).
4. **Copy-pasteable command blocks**, grouped by package, each command annotated with a trailing `# comment` explaining what it does and where output lands.
5. **Tables for parallel structure** — endpoint lists, demo indexes, language-parity file mappings, wiring touch-points. If two things map 1:1, use a table.
6. **Principle sections** (`## <Area> Principles`) capturing *design rules and rationale*, not just structure — the "why we do X, not Y" that prevents a future session from regressing intent.
7. **Dense but navigable.** Length is fine (the current file is ~550 lines) as long as every line earns its place. Cut filler, keep specifics. No marketing language, no "this powerful framework".
8. **Load-bearing detail only.** Thresholds, exact file-name conventions, protected files, gotchas ("ignore submodule drift"), and non-obvious invariants. Skip anything a reader could infer from the code in 5 seconds.

## Procedure

### 1. Detect scope and freshness

```bash
# Repo root + existing instructions
git rev-parse --show-toplevel 2>/dev/null
find . -maxdepth 3 -name CLAUDE.md -not -path '*/node_modules/*' -not -path '*/.git/*'
git remote -v 2>/dev/null | head -4          # canonical repo / fork context
git log --oneline -15                         # recent direction / active feature work
```

If a CLAUDE.md exists, read it fully first. Note which sections are hand-authored philosophy (keep verbatim) vs. auto-derived reference (candidate for refresh). Diff intent: are there modules/commands in the tree with no coverage, or covered sections that no longer match the code?

### 2. Map the repo layout and subprojects

```bash
ls -la                                         # top-level shape
find . -maxdepth 2 \( -name package.json -o -name pyproject.toml -o -name setup.py \
  -o -name Cargo.toml -o -name go.mod -o -name build.gradle -o -name pom.xml \
  -o -name Gemfile -o -name '*.csproj' \) -not -path '*/node_modules/*'
```

Each manifest is a subproject with its own build/test story. In OpenRappter that's `typescript/` (Node ≥20, ES modules, package.json) and `python/` (pyproject.toml, hatch, pytest). Record the version and runtime for each. Flag reference-only or vendored dirs the reader should ignore (e.g. `openclaw/` is a competitor copy — "ignore submodule pointer drift").

### 3. Extract the REAL build/test/lint commands

Trust CI and manifests over guessing. CI is the source of truth for canonical commands.

```bash
# CI = ground truth for what commands must pass
cat .github/workflows/*.yml 2>/dev/null | grep -nE 'run:|working-directory:' | head -60
# Node scripts
[ -f typescript/package.json ] && command -v jq >/dev/null && jq -r '.scripts' typescript/package.json
# Python test/tool config
grep -nE '\[tool\.(pytest|ruff|black|mypy)|testpaths|name =|version =' python/pyproject.toml 2>/dev/null
```

For OpenRappter the canonical commands are (verify they still exist before writing them):

```bash
# TypeScript (typescript/)
cd typescript
npm ci                                  # clean install (CI uses ci, not install)
npm run build                           # tsc → dist/
npm run lint                            # eslint src/
npm test                                # vitest run (all)
npx vitest run src/path/to/file.test.ts # single file

# Python (python/)
cd python
python -m pytest                        # testpaths = ["tests"]
python -m pytest tests/test_x.py -k name # single test

# Dashboard UI (typescript/ui/) and macOS bar (macos/, swift build) if present
```

Include a **"run a single test"** line for each package — it is the highest-frequency command a session runs. Never write a command you did not confirm exists in a manifest or CI file.

### 4. Discover architecture and key modules

```bash
# Directory-level subsystem map (adjust roots per language)
find typescript/src python/openrappter -maxdepth 1 -type d 2>/dev/null | sort
# Central abstractions — base classes, interfaces, registries, entry points
grep -rEl 'abstract class|class .*Base|interface [A-Z]|def perform|registerAgent|createStorageAdapter' \
  typescript/src python/openrappter 2>/dev/null | head -40
# Test topology reveals what's considered load-bearing
find . -path '*__tests__*' -o -name 'test_*.py' -o -name '*.test.ts' 2>/dev/null | sed 's#/[^/]*$##' | sort -u | head
```

For each major subsystem write an `## Architecture: <Name>` section. Read the actual entry-point file to get types and flow right (e.g. `BasicAgent.execute() → slosh() → perform()`). Do not paraphrase from memory — open the file. If two implementations mirror each other (TypeScript ↔ Python here), produce a **Language Parity** table mapping file ↔ file, and note where parity tests live.

### 5. Capture conventions and design principles

Read the top of the existing CLAUDE.md and grep for repeated patterns to surface conventions that aren't obvious from a single file:

- Naming/file conventions (e.g. `CamelCase` → `snake_case_agent.py`; `_agent.js` suffix in TS).
- Protected/core files that must not be deleted or edited casually.
- Non-obvious invariants and gotchas (worktree etiquette, "hot-load vs. requires build", threshold rules for scoring, "ignore submodule drift").
- Design principles with rationale — the graduated-threshold / inclusive-boundary style `## <Area> Principles` sections. Preserve these; they encode intent a future session would otherwise regress.

### 6. Assemble the file

Recommended section order (include only sections that apply; keep existing hand-authored ones):

1. Title + self-identifying line + one-paragraph **Project Overview**.
2. **Development Philosophy** / workflow norms (preserve existing prose).
3. **Git / Worktree Etiquette** if the repo uses worktrees or has multi-session norms.
4. **Repository Layout** — one line per top-level dir, flag reference-only dirs.
5. **Build & Test Commands** — grouped per package, annotated, with single-test lines.
6. Per-language/tooling **Configuration** (target, module system, strictness, test runner, validation lib).
7. **`## Architecture: <System>`** sections — one per major subsystem, each ending in a **Files:** anchor.
8. **Language / Implementation Parity** table if mirrored implementations exist.
9. **`## <Area> Principles`** sections for design rules with rationale.
10. **Conventions**: naming, file layout, protected files, gotchas.
11. **UX / interaction principles** if the product has them (e.g. "inline resolution over error messages").

### 7. Verify before finishing

```bash
# Every fenced command block should be runnable — sanity-check the ones you added
cd typescript && npm run -s 2>/dev/null | head       # confirm scripts exist
grep -oE '`[^`]+/[^`]+`' CLAUDE.md | tr -d '`' | while read p; do \
  [ -e "$p" ] || echo "MISSING PATH: $p"; done       # flag any path that doesn't exist
```

Fix every `MISSING PATH` — a wrong path is worse than an omitted one. Re-read the file top to bottom and delete any line that a reader could infer trivially or that you could not verify against the tree.

## Guardrails

- **Never invent commands, paths, versions, or ports.** If you can't confirm it from a manifest, CI, or the tree, don't write it. A file full of verified facts and a few gaps beats a complete-looking file with fabrications.
- **Refresh, don't clobber.** Preserve human-authored philosophy, principles, and prose. When updating, change only what's stale; keep the section skeleton the user already relies on.
- **Anchor to real files.** Every subsystem section names its source file(s) and test file(s). Run the missing-path check.
- **No fluff.** Cut marketing adjectives, restatements of the obvious, and anything a session could learn faster by reading the code.
- **Match the existing house style** if a CLAUDE.md is present — mirror its heading conventions (`## Architecture: …`), table format, and density rather than imposing a different shape.
- **Confirm destination before writing** if the user hasn't specified where, and confirm before overwriting a substantial existing file.
- **Don't run mutating commands** during discovery (installs, builds, migrations). Discovery is read-only: `ls`, `find`, `grep`, `cat`, `git log`, `jq` on manifests. Building/testing is the user's call.
- **Keep secrets out.** Never copy tokens, keys, or credentials from `.env`, config, or history into CLAUDE.md.
