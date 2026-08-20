"""Private directories must be private all the way down, like the TypeScript runtime.

``Path.mkdir(parents=True, mode=0o700)`` applies ``mode`` only to the final
directory: CPython creates missing ancestors with the default permissions and
ignores ``mode`` entirely for them.  Node's
``mkdirSync(dir, { recursive: true, mode: 0o700 })`` applies the mode to every
directory it creates.  The two runtimes share the same on-disk layout, so
whichever one happens to create ``~/.openrappter`` first decided whether it was
world-readable.

These tests pin the Node semantics for Python.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from openrappter.flight_recorder import private_mkdir


REPO_ROOT = Path(__file__).resolve().parents[2]
PRODUCT_ROOT = REPO_ROOT / "python" / "openrappter"

# The exact idiom this module exists to eliminate. Backticked occurrences are
# prose (docstrings that name the bad pattern), and the helper's own single
# canonical call opts out explicitly.
LEAKY_MKDIR = re.compile(
    r"\.mkdir\(\s*parents\s*=\s*True[^)]*mode\s*=\s*0o700\)"
    r"(?!`)(?!\s*#\s*private-mkdir-canonical)"
)


def modes(*paths: Path) -> list[str]:
    return [oct(path.stat().st_mode & 0o777) for path in paths]


def test_private_mkdir_creates_every_missing_ancestor_privately(tmp_path):
    leaf = tmp_path / "home" / ".openrappter" / "show-and-tell"

    private_mkdir(leaf)

    assert modes(leaf, leaf.parent, leaf.parent.parent) == ["0o700"] * 3


def test_private_mkdir_matches_node_and_leaves_existing_ancestors_alone(tmp_path):
    """Node applies the mode only to directories it actually creates."""
    existing = tmp_path / "shared"
    existing.mkdir()
    existing.chmod(0o755)  # explicit: mkdir(mode=) is filtered by the ambient umask
    leaf = existing / "nested" / "private"

    private_mkdir(leaf)

    assert modes(existing) == ["0o755"], "an ancestor we did not create was modified"
    assert modes(leaf, leaf.parent) == ["0o700", "0o700"]


def test_private_mkdir_hardens_an_existing_leaf_that_is_too_permissive(tmp_path):
    leaf = tmp_path / "leaf"
    leaf.mkdir()
    leaf.chmod(0o755)

    private_mkdir(leaf)

    assert modes(leaf) == ["0o700"]


def test_private_mkdir_is_idempotent(tmp_path):
    leaf = tmp_path / "a" / "b" / "c"

    private_mkdir(leaf)
    private_mkdir(leaf)

    assert modes(leaf, leaf.parent, leaf.parent.parent) == ["0o700"] * 3


def test_no_product_code_still_uses_the_leaky_idiom():
    """Guard the whole class, not just the sites that existed when this landed."""
    sources = sorted(PRODUCT_ROOT.rglob("*.py"))
    assert sources, "found no product sources to scan"

    offenders = [
        str(path.relative_to(REPO_ROOT))
        for path in sources
        if LEAKY_MKDIR.search(path.read_text(encoding="utf-8"))
    ]

    assert offenders == [], (
        "mkdir(parents=True, mode=0o700) silently leaves ancestors world-readable; "
        f"use private_mkdir() instead: {offenders}"
    )


@pytest.mark.parametrize(
    "module",
    [
        "openrappter.show_and_tell",
        "openrappter.flight_recorder",
        "openrappter.brainstem",
        "openrappter.imessage.config",
        "openrappter.imessage.state",
    ],
)
def test_privacy_sensitive_modules_import_the_helper(module):
    imported = __import__(module, fromlist=["private_mkdir"])
    assert hasattr(imported, "private_mkdir"), (
        f"{module} creates private directories and must use private_mkdir"
    )
