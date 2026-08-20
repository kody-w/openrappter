"""Accuracy gate for the TS<->Python parity map.

``.claude/skills/ts-python-parity-check/SKILL.md`` calls its file-pair table the
"source of truth" for parity audits, and it is: an auditor resolves a changed
file to its mirror through that table. That makes the map load-bearing, and it
makes one particular error silent and expensive -- a claim that a module has
**no Python counterpart** when Python code for it exists. Such a claim does not
produce a warning; it instructs the auditor to skip real, shipped code, so
divergences in that module accumulate unnoticed and every audit reports a clean
pass. A missing table row fails the same way.

This gate checks the map against the filesystem in both directions:

* every path the table names must exist (no dangling rows);
* every module declared to have no Python counterpart must genuinely have none.

Deliberately NOT checked:

* Whether the two sides of a pair are *at parity*. That is the skill's job, and
  it needs semantic comparison; this gate only asserts the map is not lying
  about what exists.
* Completeness of the table. Requiring a row for every Python module would
  force rows for internal helpers that have no TS mirror by design, and a gate
  that fails for benign reasons gets disabled. Absence claims are checked
  because those are the ones that silence an audit.

The filesystem is read directly rather than through ``git grep`` on purpose: a
check whose result depends on whether a file has been committed yet passes
locally on new files and fails in CI, or worse, the reverse.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL = REPO_ROOT / ".claude/skills/ts-python-parity-check/SKILL.md"
PY_PACKAGE = REPO_ROOT / "python/openrappter"

# A pair-table row: | module | ts | python | ts test | py test |
ROW = re.compile(r"^\|(?P<cells>.+)\|\s*$")
BACKTICKED = re.compile(r"`([^`]+)`")

# The structured absence list this gate pins. Prose may describe it, but exactly
# one machine-readable copy may exist, so the two cannot drift apart.
ABSENCE_HEADING = "## Modules with no Python counterpart"
BULLET = re.compile(r"^-\s+`(?P<name>[^`]+)`\s*(?:--|—)\s*(?P<why>.+)$")

# Anti-vacuity floors. Every silent false-clean this gate could suffer comes
# from a regex that matched nothing, so a parse that finds implausibly little
# is treated as a failure rather than a pass.
MIN_PAIR_ROWS = 12
MIN_ABSENCE_ENTRIES = 1


def _skill_text() -> str:
    assert SKILL.is_file(), f"parity skill not found at {SKILL}"
    return SKILL.read_text(encoding="utf-8")


def _pair_rows() -> list[tuple[str, list[str]]]:
    """Return (module, [referenced paths]) for each pair-table row."""
    rows: list[tuple[str, list[str]]] = []
    for line in _skill_text().splitlines():
        m = ROW.match(line.strip())
        if not m:
            continue
        cells = [c.strip() for c in m.group("cells").split("|")]
        if len(cells) < 2 or set(cells[0]) <= {"-", ":"}:
            continue  # separator row
        paths = [p for c in cells[1:] for p in BACKTICKED.findall(c) if "/" in p]
        if paths:
            rows.append((cells[0], paths))
    return rows


def _absence_entries() -> list[str]:
    """Module names declared to have no Python counterpart."""
    text = _skill_text()
    start = text.find(ABSENCE_HEADING)
    assert start != -1, (
        f"{SKILL.name} must declare its absence claims under a "
        f"{ABSENCE_HEADING!r} heading so they can be verified."
    )
    body = text[start + len(ABSENCE_HEADING) :]
    end = body.find("\n## ")
    if end != -1:
        body = body[:end]
    return [m.group("name") for line in body.splitlines() if (m := BULLET.match(line.strip()))]


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _python_evidence(name: str) -> list[Path]:
    """Python modules that would contradict a 'no Python counterpart' claim."""
    stem = _snake(name)
    hits: list[Path] = []
    for path in PY_PACKAGE.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        # A module file named for it, or any module inside a package named for it.
        if path.stem == stem or stem in {p.lower() for p in path.parent.parts}:
            hits.append(path)
    return sorted(hits)


# ── The map must not name files that do not exist ──


def test_pair_table_paths_all_exist() -> None:
    rows = _pair_rows()
    assert len(rows) >= MIN_PAIR_ROWS, (
        f"parsed only {len(rows)} pair rows (floor {MIN_PAIR_ROWS}); the table "
        "format likely changed and this gate is no longer reading it"
    )
    missing = [
        f"{module}: {path}"
        for module, paths in rows
        for path in paths
        if not (REPO_ROOT / path).exists()
    ]
    assert not missing, "parity map references paths that do not exist:\n  " + "\n  ".join(missing)


# ── The map must not claim real code is absent ──


def test_absence_claims_are_true() -> None:
    entries = _absence_entries()
    assert len(entries) >= MIN_ABSENCE_ENTRIES, (
        f"parsed only {len(entries)} absence entries (floor {MIN_ABSENCE_ENTRIES}); "
        "the bullet format likely changed and this gate is no longer reading it"
    )
    contradicted = []
    for name in entries:
        evidence = _python_evidence(name)
        if evidence:
            shown = ", ".join(str(p.relative_to(REPO_ROOT)) for p in evidence[:3])
            contradicted.append(f"{name} -> {shown}")
    assert not contradicted, (
        "parity map claims these modules have no Python counterpart, but Python "
        "code for them exists -- an audit told to skip them would silently pass "
        "over shipped code:\n  " + "\n  ".join(contradicted)
    )


@pytest.mark.parametrize("name", ["gateway", "WatchmakerAgent", "mcp"])
def test_regression_subsystems_are_never_declared_absent(name: str) -> None:
    """These three were each wrongly declared absent while shipping in Python.

    Pinned by name because the generic check above only holds while the resolver
    keeps working; if ``_python_evidence`` ever silently stops finding modules,
    the generic test degrades to a pass and this one still fails.
    """
    assert _python_evidence(name), f"expected Python code for {name}; resolver may be broken"
    assert name not in _absence_entries(), (
        f"{name} ships in Python and must not be declared absent in the parity map"
    )
