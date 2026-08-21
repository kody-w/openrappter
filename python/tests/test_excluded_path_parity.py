"""Both runtimes must exclude the same credential-bearing files.

Exclusion is not about hiding the path -- a path is not a secret. When a
recorded object carries a file locator for an excluded path, *every* sibling
field in that object is replaced with ``[excluded-path]``, including
``content``. So a credential file missing from the list means its **contents**
are written to the flight log.

Measured before this test existed, ``.netrc``, ``.npmrc``, ``.pypirc``,
``.pgpass``, ``.htpasswd``, ``.docker/config.json``, ``.kube/config``,
``.gnupg`` and the ``.pfx``/``.jks`` siblings of the already-excluded ``.p12``
were all absent. Value-pattern matching rescued some contents by luck, but an
``.npmrc`` auth token and a ``.pgpass`` line reached the log verbatim.

``must_keep`` matters as much: a false positive here blanks a whole record, not
one field.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openrappter.flight_recorder import (
    EXCLUDED_PATH,
    MAX_FILE_METADATA_FIELD_BYTES,
    is_excluded_flight_path,
    sanitize_flight_metadata,
)

CORPUS = Path(__file__).resolve().parents[2] / "contracts" / "excluded-path-corpus.json"
_CASES = json.loads(CORPUS.read_text())

#: Matches no value pattern, so only the path exclusion can keep it out. Named
#: without the word "secret": a high-entropy literal under a secret-shaped name
#: is what a scanner looks for, and the repo may not contain one even in a test.
OPAQUE_VALUE = "a7Fq2Xm9Lp4Rt8Wz"


@pytest.mark.parametrize("path", _CASES["must_exclude"])
def test_a_credential_file_is_excluded(path):
    assert is_excluded_flight_path(path), f"{path!r} would be recorded"


@pytest.mark.parametrize("path", _CASES["must_exclude"])
def test_the_contents_of_a_credential_file_never_reach_the_log(path):
    """The point of the exclusion: siblings are blanked, not just the locator."""
    recorded = sanitize_flight_metadata({"path": path, "content": OPAQUE_VALUE})
    assert recorded["content"] == EXCLUDED_PATH


@pytest.mark.parametrize("path", _CASES["must_keep"])
def test_an_ordinary_file_is_not_excluded(path):
    """A false positive blanks every sibling field, destroying the record."""
    assert not is_excluded_flight_path(path), f"{path!r} was excluded; the record is lost"


# --- the one deliberate hole in the blanking sweep -------------------------

SAFE = _CASES["safe_metadata_fields"]
EXCLUDED_FILE = _CASES["must_exclude"][0]


@pytest.mark.parametrize("field", SAFE["numeric"])
def test_a_numeric_metadata_field_survives_next_to_an_excluded_path(field):
    """These describe the file rather than reveal it, so they ride along."""
    recorded = sanitize_flight_metadata({"path": EXCLUDED_FILE, field: 12})
    assert recorded[field] == 12


@pytest.mark.parametrize("field", SAFE["text"])
def test_a_text_metadata_field_survives_next_to_an_excluded_path(field):
    recorded = sanitize_flight_metadata({"path": EXCLUDED_FILE, field: "text/plain"})
    assert recorded[field] == "text/plain"


@pytest.mark.parametrize("field", ["content", "body", "text", "data", "lines"])
def test_a_field_outside_the_allowlist_is_blanked(field):
    """The allowlist is the whole hole: everything else is still blanked."""
    recorded = sanitize_flight_metadata(
        {"path": EXCLUDED_FILE, field: OPAQUE_VALUE}
    )
    assert recorded[field] == EXCLUDED_PATH


@pytest.mark.parametrize("field", SAFE["text"])
@pytest.mark.parametrize(
    "value,why",
    [
        ("\U0001F600" * 200, "astral: 200 code points, 400 UTF-16 units, 800 bytes"),
        ("\u044f" * 200, "cyrillic: 200 code points, 200 UTF-16 units, 400 bytes"),
    ],
)
def test_the_metadata_budget_is_measured_in_utf8_bytes(field, value, why):
    """A runtime's idea of string length is not a byte budget.

    ``len()`` counts code points and JavaScript's ``.length`` counts UTF-16
    code units, so an astral string sits on opposite sides of the same
    numeric limit in the two runtimes. Measured before this test existed:
    Python kept a 200-emoji ``mime`` value verbatim next to an excluded
    credential path while TypeScript blanked it. The Cyrillic case overruns
    the budget by byte while fitting *both* runtimes' native length, so it
    was kept by both.
    """
    budget = SAFE["maxTextBytes"]
    assert len(value) <= budget, f"{why}: must fit the limit by code point"
    assert len(value.encode("utf-8")) > budget, f"{why}: but overrun it by byte"

    recorded = sanitize_flight_metadata({"path": EXCLUDED_FILE, field: value})
    assert recorded[field] == EXCLUDED_PATH


@pytest.mark.parametrize("field", SAFE["text"])
def test_a_metadata_value_that_fits_the_byte_budget_still_survives(field):
    value = "a" * SAFE["maxTextBytes"]
    recorded = sanitize_flight_metadata({"path": EXCLUDED_FILE, field: value})
    assert recorded[field] == value


def test_the_allowlist_itself_is_what_both_runtimes_implement():
    """Pin the data, not just the behaviour.

    Every other test here is parametrized over the contract, so quietly
    dropping a name from it would shrink the suite instead of failing it.
    """
    assert set(SAFE["numeric"]) == {"size", "length"}
    assert set(SAFE["text"]) == {"language", "mime", "mimetype", "extension"}
    assert SAFE["maxTextBytes"] == MAX_FILE_METADATA_FIELD_BYTES


# ---------------------------------------------------------------------------
# Deeply nested data that holds no excluded path anywhere.
#
# Classifying a value as "hides an excluded file locator" requires walking it,
# and the walk gives up past a depth budget and fails closed. That guard is
# only meaningful for containers. A leaf has no keys, so the answer is exact
# at any depth -- and if the guard is consulted before that is noticed, two
# structures of identical shape get classified differently purely because one
# ends in a string and the other ends in a number.
# ---------------------------------------------------------------------------

DEPTH = _CASES["depth_guard"]
LEAVES = {"string": "leaf", "number": 42, "boolean": True, "null": None}


def _chain(depth, leaf):
    node = leaf
    for _ in range(depth):
        node = {"n": node}
    return node


def _nest(node):
    """How many levels survive, and what sits at the bottom."""
    levels = 0
    while isinstance(node, dict) and list(node.keys()) == ["n"]:
        node = node["n"]
        levels += 1
    while isinstance(node, list) and len(node) == 1:
        node = node[0]
        levels += 1
    return levels, node


def test_the_depth_guard_is_only_consulted_for_containers():
    assert DEPTH["maxTraversalDepth"] == 16
    assert DEPTH["nonContainerIsNeverAContainerOfLocators"] is True


@pytest.mark.parametrize("name,leaf", sorted(LEAVES.items()))
def test_the_leaf_type_does_not_decide_whether_deep_data_survives(name, leaf):
    """Same shape, same depth, different leaf -- must be treated the same."""
    depth = DEPTH["maxTraversalDepth"] + 1
    reference = sanitize_flight_metadata({"deep": _chain(depth, "leaf")})
    recorded = sanitize_flight_metadata({"deep": _chain(depth, leaf)})
    assert _nest(recorded["deep"])[0] == _nest(reference["deep"])[0]


@pytest.mark.parametrize("name,leaf", sorted(LEAVES.items()))
def test_a_chain_within_the_depth_budget_survives_whatever_it_ends_in(
    name, leaf
):
    depth = DEPTH["maxTraversalDepth"]
    recorded = sanitize_flight_metadata({"deep": _chain(depth, leaf)})
    levels, bottom = _nest(recorded["deep"])
    assert levels == depth
    assert bottom == leaf


@pytest.mark.parametrize("name,leaf", sorted(LEAVES.items()))
def test_a_nested_array_within_the_budget_is_not_mistaken_for_a_path(
    name, leaf
):
    node = leaf
    for _ in range(DEPTH["maxTraversalDepth"]):
        node = [node]
    recorded = sanitize_flight_metadata({"top": node})
    assert recorded["top"] != EXCLUDED_PATH
    levels, bottom = _nest(recorded["top"])
    assert levels == DEPTH["maxTraversalDepth"]
    assert bottom == leaf


@pytest.mark.parametrize("name,leaf", sorted(LEAVES.items()))
def test_shallow_ordinary_data_never_grows_an_excluded_path_marker(name, leaf):
    recorded = sanitize_flight_metadata({"deep": _chain(8, leaf)})
    assert EXCLUDED_PATH not in json.dumps(recorded)


@pytest.mark.parametrize("depth", [1, 5, 16, 17, 20])
def test_a_real_excluded_path_is_still_caught_at_any_depth(depth):
    """The guard must keep working -- this is what the depth budget protects."""
    node = {"path": EXCLUDED_FILE, "content": "TOPSECRET"}
    for _ in range(depth):
        node = {"n": node}
    recorded = sanitize_flight_metadata({"wrap": node, "sib": OPAQUE_VALUE})
    assert "TOPSECRET" not in json.dumps(recorded)
    assert recorded["sib"] == EXCLUDED_PATH


@pytest.mark.parametrize("name,leaf", sorted(LEAVES.items()))
def test_one_level_past_the_budget_the_walk_gives_up(name, leaf):
    """Pins the far edge of the budget, which is what makes the number real.

    Beyond it the recorder cannot prove the data is clean, so it fails closed
    and replaces it -- the deliberate cost of a bounded walk.
    """
    depth = DEPTH["maxTraversalDepth"] + 1
    recorded = sanitize_flight_metadata({"deep": _chain(depth, leaf)})
    assert recorded["deep"] == EXCLUDED_PATH


def test_a_cycle_is_not_mistaken_for_a_hidden_path():
    """A value already being walked cannot introduce a locator it did not have."""
    node = {"x": 1}
    node["self"] = node
    recorded = sanitize_flight_metadata({"top": node})
    assert recorded["top"]["x"] == 1
