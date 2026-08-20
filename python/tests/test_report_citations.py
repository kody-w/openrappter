"""Citation gate for generated review reports.

Fabricated citations are a recurring failure mode of model-generated audits: a
finding names a symbol that sounds plausible, cites a real file path and a
specific line range, and is asserted with high confidence -- but the symbol has
never existed. ``fable5/reports/code-review.md`` shipped five such findings,
including its #1 top priority (see that file's Retractions section).

This gate checks the one property that is *time invariant*: a cited symbol must
exist somewhere in the source tree. Deliberately NOT checked:

* Line numbers. Code moves; a report is a point-in-time artifact. Enforcing
  line bounds would make this test fail on unrelated refactors, and a test that
  fails for benign reasons gets disabled.
* Where the symbol lives. ``_trusted_context`` is real (it is in brainstem.py)
  even though the retracted finding claimed it was in chain.py. This gate would
  NOT have caught that half of the claim -- it catches invented symbols, not
  misplaced real ones. That limit is intentional; a location check is a line
  check by another name.

Scope is limited to ``Evidence:`` bullets, which assert what *is*. ``Fix:``
bullets propose what *should* exist and would be false positives by design.
"""

from __future__ import annotations

import re
import subprocess
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
REPORT_GLOB = "fable5/reports/*.md"

# Claims about what IS. Fix/recommendation bullets are excluded on purpose.
EVIDENCE = re.compile(r"^\s*-\s*Evidence:")

# A retracted claim keeps its original wording for the audit record, so its
# (fabricated) symbols must stay exempt. Only RETRACTED exempts: a claim marked
# CONFIRMED or PLAUSIBLE is still asserting something true and must still cite
# real symbols.
RETRACTION = re.compile(r"^\s*-\s*\*\*RETRACTED\b")

SYMBOL = re.compile(
    r"_[A-Z][A-Z0-9_]{4,}"                 # _UPPER_SNAKE constants
    r"|\b[A-Z][A-Z0-9_]{5,}\b"             # UPPER_SNAKE constants
    r"|_[a-z]+(?:_[a-z]+)+"                # _private_snake_case identifiers
    r"|\b[a-zA-Z_][a-zA-Z0-9_]{3,}(?=\()"  # call shapes: name(
)

# ``Foo.md`` is a filename reference, not a code symbol.
FILENAME_SUFFIX = re.compile(r"^\.(md|yml|yaml|json|txt|toml|lock)\b")

# Searched for symbol existence. Markdown is excluded on purpose: a report
# quoting its own invented symbol must never count as proof the symbol exists.
SOURCE_GLOBS = ("*.ts", "*.tsx", "*.py", "*.js", "*.mjs", "*.cjs",
                "*.json", "*.yml", "*.yaml", "*.sh", "*.swift")

# Floors that make a "clean" run meaningful. If extraction silently breaks --
# the usual cause of a false all-clear -- these fail loudly instead.
MIN_REPORTS = 1
MIN_EVIDENCE_LINES = 30
MIN_DISTINCT_SYMBOLS = 20

# Fabricated claims currently retracted in fable5/reports/code-review.md.
# Pinned so a future edit cannot quietly drop a retraction and leave the false
# claim standing unmarked.
EXPECTED_RETRACTED_EVIDENCE_LINES = 5


def _reports() -> list[Path]:
    return sorted(REPO_ROOT.glob(REPORT_GLOB))


def _symbol_exists(symbol: str) -> bool:
    proc = subprocess.run(
        ["git", "grep", "--fixed-strings", "-l", symbol, "--", *SOURCE_GLOBS],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    return proc.returncode == 0 and bool(proc.stdout.strip())


def _scan() -> dict:
    unretracted: list[tuple[str, int, str]] = []
    retracted_lines = 0
    evidence_lines = 0
    symbols: set[str] = set()

    for report in _reports():
        raw = report.read_text(encoding="utf-8").split("\n")
        for index, line in enumerate(raw):
            if not EVIDENCE.search(line):
                continue
            evidence_lines += 1

            following = next(
                (nxt for nxt in raw[index + 1:] if nxt.strip()), ""
            )
            is_retracted = bool(RETRACTION.search(following))
            if is_retracted:
                retracted_lines += 1

            for match in SYMBOL.finditer(line):
                symbol = match.group(0)
                if FILENAME_SUFFIX.match(line[match.end():match.end() + 8]):
                    continue
                symbols.add(symbol)
                if is_retracted:
                    continue
                if not _symbol_exists(symbol):
                    unretracted.append(
                        (str(report.relative_to(REPO_ROOT)), index + 1, symbol)
                    )

    return {
        "reports": len(_reports()),
        "evidence_lines": evidence_lines,
        "retracted_lines": retracted_lines,
        "symbols": symbols,
        "unretracted": unretracted,
    }


@pytest.fixture(scope="module")
def scan() -> dict:
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("citation gate needs git history to resolve symbols")
    return _scan()


def test_scanner_actually_scanned_something(scan):
    """A broken extractor reports zero problems. Prove it read the reports."""
    assert scan["reports"] >= MIN_REPORTS, "no report files matched the glob"
    assert scan["evidence_lines"] >= MIN_EVIDENCE_LINES, (
        f"only {scan['evidence_lines']} Evidence lines parsed; the bullet "
        "format likely changed and this gate is no longer reading claims"
    )
    assert len(scan["symbols"]) >= MIN_DISTINCT_SYMBOLS, (
        f"only {len(scan['symbols'])} distinct symbols extracted; the symbol "
        "regex likely broke, so an all-clear result would be meaningless"
    )


def test_no_report_cites_a_symbol_that_does_not_exist(scan):
    """Every symbol asserted as evidence must exist in the source tree."""
    if scan["unretracted"]:
        detail = "\n".join(
            f"  {path}:{line} cites '{symbol}' -- not found in any source file"
            for path, line, symbol in scan["unretracted"]
        )
        pytest.fail(
            "Report Evidence cites symbols that do not exist in the "
            f"codebase:\n{detail}\n\n"
            "Either correct the claim, or annotate it with a "
            "'- **RETRACTED' bullet on the following line preserving the "
            "original text (see fable5/reports/code-review.md)."
        )


def test_known_fabrications_remain_retracted(scan):
    """A retraction must not be silently deleted, leaving the claim standing."""
    assert scan["retracted_lines"] == EXPECTED_RETRACTED_EVIDENCE_LINES, (
        f"expected {EXPECTED_RETRACTED_EVIDENCE_LINES} retracted Evidence "
        f"lines, found {scan['retracted_lines']}; a retraction was removed or "
        "added without updating this pin"
    )


def test_the_headline_fabrication_is_still_marked():
    """Pin the specific claim that ranked #1: it was inverted, not just wrong."""
    report = REPO_ROOT / "fable5" / "reports" / "code-review.md"
    text = report.read_text(encoding="utf-8")
    assert "_RESERVED_RUNTIME_FIELDS" in text, "original claim must be preserved"
    assert "## Retractions" in text, "Retractions section is missing"
    assert text.count("**RETRACTED (2026-08-20).**") == \
        EXPECTED_RETRACTED_EVIDENCE_LINES


def test_gate_would_catch_a_newly_invented_symbol(scan):
    """The detector must fire on a symbol that certainly does not exist.

    The canary is built at runtime rather than written as a literal. A literal
    would be committed into this very file, `*.py` is searched, and the symbol
    would therefore exist -- the test would silently invert and start asserting
    that a real symbol is absent. That is the same self-reference trap as the
    `*.md` exclusion above: an artifact must never be able to prove its own
    citation.
    """
    canary = "_absent_symbol_" + uuid.uuid4().hex
    assert not _symbol_exists(canary), \
        "existence check returned true for an invented symbol"
    # ...and must still confirm real ones, so it is not just always-false.
    assert _symbol_exists("_execute_with_timeout"), \
        "existence check failed on a symbol known to be present"
