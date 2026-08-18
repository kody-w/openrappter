"""R8 has to be able to fail.

R8 asserts that the RAPP substrate is attributed, and its own docstring calls
that "the licence condition". It tested ``"rapp" in body``, which the project's
own name satisfies — open**rapp**ter contains it — so the check passed on a
README with every mention of the substrate deleted. It reported compliance with
a licence obligation without ever having looked.

``"mit"`` was the same shape: satisfied by "commit", "submit" or "permit".
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import conformance  # noqa: E402


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A throwaway repo root whose README this test controls."""
    monkeypatch.setattr(conformance, "ROOT", str(tmp_path))
    return tmp_path


def test_the_project_name_alone_is_not_attribution(repo):
    # Every token R8 used to look for, and no attribution whatsoever:
    # "openrappter" contains "rapp", and "commit" contains "mit".
    (repo / "README.md").write_text(
        "# openrappter\n\nRun openrappter, then commit your changes.\n",
        encoding="utf-8",
    )
    ok, detail = conformance.r8_attribution()
    assert not ok, detail


def test_a_real_attribution_passes(repo):
    (repo / "README.md").write_text(
        "# openrappter\n\nBuilt on RAPP, which is MIT-licensed.\n",
        encoding="utf-8",
    )
    ok, detail = conformance.r8_attribution()
    assert ok, detail


def test_attribution_may_live_in_notice_instead(repo):
    # R8 accepts any of README, LICENSE or NOTICE; a README that does not
    # attribute must not stop a NOTICE that does from counting.
    (repo / "README.md").write_text("# openrappter\n\nJust commit.\n",
                                    encoding="utf-8")
    (repo / "NOTICE").write_text("This product includes RAPP (MIT).\n",
                                 encoding="utf-8")
    ok, detail = conformance.r8_attribution()
    assert ok, detail


def test_mit_must_be_a_word_not_a_fragment(repo):
    # "permit" is not a licence.
    (repo / "README.md").write_text(
        "# openrappter\n\nBuilt on RAPP. We permit anything.\n", encoding="utf-8"
    )
    ok, _ = conformance.r8_attribution()
    assert not ok


def test_the_shipped_repository_really_is_attributed():
    # Anti-vacuity in the other direction: the rule above must not be so strict
    # that the repository it ships in fails it.
    ok, detail = conformance.r8_attribution()
    assert ok, detail
