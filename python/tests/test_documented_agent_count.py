"""The documented Python agent count, checked against a fresh install.

`architecture.html` said 26 Python agents. That is the number of `.py` files in
the agents directory, not the number the runtime registers — six of those files
are not standalone agents. The TypeScript figure beside it was taken from
`--list-agents`, so the page compared a file count against a registration count
and made the two runtimes look further apart than they are.

Counting the way a person experiences it means asking the registry, with `HOME`
pointed somewhere empty: `--list-agents` also loads the operator's own agents,
and a published figure that includes those describes a laptop rather than the
product. That is exactly how the TypeScript number came to say 37.
"""

import re
import sys
from pathlib import Path

import pytest

from openrappter.cli import AgentRegistry

ROOT = Path(__file__).resolve().parents[2]
DOC_FILES = [
    ROOT / "docs" / "architecture.html",
    ROOT / "README.md",
]


@pytest.fixture
def built_in_count():
    """Agents a fresh install registers.

    Several suites install a *stub* `agents` / `agents.basic_agent` into
    `sys.modules` at import time to simulate the grail brainstem, and those
    stubs persist for the rest of the run. With them present the portable
    agents subclass a different BasicAgent than the registry checks against,
    and the count drops from 20 to 16 — so this test passed alone and failed in
    the full suite.

    Nothing installs those stubs in production. They are removed for the
    duration and put back, so the suites that rely on them are unaffected.
    """
    saved = {
        name: sys.modules.pop(name)
        for name in ("agents", "agents.basic_agent")
        if name in sys.modules
    }
    try:
        yield len(AgentRegistry().discover_agents())
    finally:
        sys.modules.update(saved)


def _nearest_language(text, index, window=60):
    """The language mentioned closest to a position, either side of it."""
    start = max(0, index - window)
    best, best_distance = None, None
    for match in re.finditer(r"python|typescript", text[start:index + window], re.I):
        position = start + match.start()
        distance = abs(position - index)
        if best_distance is None or distance < best_distance:
            best, best_distance = match.group(0).lower(), distance
    return best


def documented_python_counts():
    """Every "<n> agents" claim that names Python, with its file."""
    found = []
    for path in DOC_FILES:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"(\d+)\s+(?:built-in\s+)?agents", text, re.I):
            # The language can sit either side of the number: the README writes
            # "Python (20 agents)", architecture.html writes "20 agents (Python)".
            # It must be the NEAREST mention, not any within the window — the
            # README puts both languages on one line, and a plain search found
            # "Python" before the TypeScript figure and mislabelled it.
            if _nearest_language(text, match.start()) == "python":
                found.append((path.name, match.group(0), int(match.group(1))))
    return found


def test_registers_a_realistic_number_of_agents(built_in_count):
    # Anti-vacuity: a registry that loaded nothing would make the comparison
    # below pass against zero.
    assert built_in_count > 10


def test_finds_a_python_count_to_check():
    # Anti-vacuity for the extractor: if the pattern or the context window
    # stopped matching, the assertion below would check an empty list.
    assert documented_python_counts(), "no documented Python agent count found"


def test_published_python_counts_match_the_runtime(built_in_count):
    wrong = [c for c in documented_python_counts() if c[2] != built_in_count]
    assert not wrong, (
        "A fresh install registers %d Python agents. These say otherwise: %s. "
        "Count with the registry, not by listing *.py — several files in that "
        "directory are not standalone agents."
        % (built_in_count, ", ".join("%s: %r" % (f, claim) for f, claim, _ in wrong))
    )
