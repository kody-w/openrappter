"""No Python module may hardcode the data directory.

TypeScript has had this guard since #331. Python did not, which is how a real
split survived: ``MemoryAgent`` resolved ``openrappterHome()`` while
``context_memory_agent.py`` spelled ``Path.home() / ".openrappter"``, so with
``OPENRAPPTER_HOME`` set the two runtimes read **different** memory files:

    typescript memory -> /tmp/split-test/memory.json
    python memory     -> /Users/…/.openrappter/memory.json

Both work; neither sees what the other wrote. That is worse than ignoring the
variable, and it is exactly the split #330 was filed about.

## Why agents are excluded entirely

Two architectural rules box them in from both sides:

* **R7** — an agent must load with no kernel imports, enforced by
  ``test_brainstem_compliance.py``. Importing ``openrappter.paths`` broke three
  agents outright.
* **R4** — declared capabilities must cover everything the code can reach, and
  ``conformance.py`` classifies any ``os.environ`` read as ``credential-access``.
  Resolving the variable inline therefore failed conformance.

So an agent can neither import the helper nor read the environment. Three of
them still hardcode the directory as a result, and ``memory.json`` remains
split between the runtimes when ``OPENRAPPTER_HOME`` is set. Closing that needs
the home injected by the loader rather than discovered by the agent — a design
change, not a path rewrite, and not something to force by breaking a rule.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "openrappter"
HELPER = PACKAGE / "paths.py"

#: A bare home-relative data directory, with no environment override in sight.
HARDCODED = re.compile(r"Path\.home\(\)\s*/\s*[\"']\.openrappter[\"']")

#: The inline form agents are allowed, because they cannot import the helper.
INLINE_OVERRIDE = re.compile(r"OPENRAPPTER_HOME")


def source_files() -> list[Path]:
    return [
        p
        for p in PACKAGE.rglob("*.py")
        if p != HELPER and "__pycache__" not in str(p)
    ]


def offending_lines(path: Path) -> list[str]:
    """Lines that hardcode the directory without honouring the variable."""
    out = []
    lines = path.read_text(encoding="utf-8").split("\n")
    for i, line in enumerate(lines):
        if not HARDCODED.search(line):
            continue
        if line.lstrip().startswith("#"):
            continue
        # The override may sit on a neighbouring line in a wrapped expression.
        window = "\n".join(lines[max(0, i - 3) : i + 2])
        if INLINE_OVERRIDE.search(window):
            continue
        out.append(f"{path.name}:{i + 1}: {line.strip()}")
    return out


class TestDataDirectoryIsNotHardcoded:
    def test_the_scan_sees_a_meaningful_number_of_files(self):
        """Guard the guard: a broken walk would make the check below vacuous."""
        files = source_files()
        assert len(files) >= 20
        assert any(f.name == "show_and_tell.py" for f in files)

    def test_the_helper_exists_and_reads_the_variable_at_call_time(self):
        source = HELPER.read_text(encoding="utf-8")
        assert "OPENRAPPTER_HOME" in source
        # A module-level constant would freeze the value at import, which is
        # the mistake the TypeScript migration made in six places.
        assert "def openrappter_home" in source

    def test_no_module_hardcodes_the_data_directory(self):
        offenders: list[str] = []
        for path in source_files():
            # Agents are excluded for the reasons in this file's docstring:
            # R7 forbids the import and R4 forbids the environment read.
            if path.parent.name == "agents":
                continue
            offenders.extend(offending_lines(path))

        assert offenders == [], (
            "these resolve the data directory without honouring "
            f"OPENRAPPTER_HOME: {offenders}"
        )

    @pytest.mark.parametrize("override", ["/tmp/relocated", None])
    def test_the_helper_answers_both_ways(self, monkeypatch, override):
        from openrappter.paths import openrappter_path

        if override is None:
            monkeypatch.delenv("OPENRAPPTER_HOME", raising=False)
            assert openrappter_path("memory.json") == (
                Path.home() / ".openrappter" / "memory.json"
            )
        else:
            monkeypatch.setenv("OPENRAPPTER_HOME", override)
            assert openrappter_path("memory.json") == Path(override) / "memory.json"

    def test_an_empty_variable_is_ignored(self, monkeypatch):
        """An exported-but-empty variable is a common shell accident."""
        from openrappter.paths import openrappter_home

        monkeypatch.setenv("OPENRAPPTER_HOME", "   ")
        assert openrappter_home() == Path.home() / ".openrappter"
