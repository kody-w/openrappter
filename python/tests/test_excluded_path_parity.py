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
