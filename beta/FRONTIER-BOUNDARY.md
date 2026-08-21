# The Frontier boundary

The Frontier is this repository's **exploratory** surface. It moves fast, it is opt-in, and it is
not the product the library ships. That is only safe if it stays in its own box.

> Everything we do on the Frontier is Frontier. The visual guides too.

## The rule

**Everything the Frontier owns lives under `beta/`, and nothing in the mainline library points at
it.** Concretely:

| Kind | Where it goes |
|---|---|
| Code, UI, tests, scripts | `beta/**` |
| Charter, product direction, boundary | `beta/` root |
| Docs, specs, visual guides, style guides | `beta/docs/**` |
| Vendored tools a Frontier proof needs | `beta/tools/**` |
| EOL and ignore rules for Frontier files | `beta/.gitattributes`, `beta/.gitignore` |
| CI for Frontier suites | its own workflow (`.github/workflows/frontier.yml`), scoped to `beta/**` |

And the mainline surface — the landing page (`index.html`), the library README, `docs/**`,
`registry.json`, the root installers, `rapp_brainstem/` — **never links to, embeds, or depends on
Frontier content.** A reader of the library must be able to use it without encountering the
Frontier at all.

One file crosses on purpose: the repository's `CLAUDE.md` points at `beta/GOLDEN_PATH.md`, because a
contributor needs the product direction before touching the Frontier. `CLAUDE.md` is a contributor
document, not a mainline surface, and the boundary test scopes itself to exactly that list
(`beta/tests/frontier-boundary.test.mjs`: `index.html`, `README.md`, `docs/*`).

## Why

1. **The library must stay boring.** It is the Microsoft-facing product; its landing page, guide and
   catalog are what a customer sees. Exploratory work advertised there reads as unfinished product.
2. **Fast movement must not gate production.** Frontier suites change hourly; if they sit in the
   mainline preflight they can redden the gate that guards `main`.
3. **Graduation should be a decision, not a drift.** When something on the Frontier is proven, it is
   promoted deliberately — moved, renamed, documented as product, and *then* linked. Nothing arrives
   in the library because a link crept in.

## Enforcement

`beta/tests/frontier-boundary.test.mjs` fails if a mainline page references `beta/` or a Frontier
guide. It reads mainline files and never modifies them. If a link is ever wanted, the test is
changed on purpose, in the same commit, with the reason — that is the graduation record.

## Promoting something off the Frontier

1. Move the files out of `beta/` to their product home.
2. Rewrite the copy as product documentation (no "beta", no exploration framing).
3. Add it to the mainline page or README, and update this test in the same commit.
4. Say in the commit message what was promoted and what proved it.
