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
    is_excluded_flight_path,
    sanitize_flight_metadata,
)

CORPUS = Path(__file__).resolve().parents[2] / "contracts" / "excluded-path-corpus.json"
_CASES = json.loads(CORPUS.read_text())

#: Matches no value pattern, so only the path exclusion can keep it out.
OPAQUE_SECRET = "a7Fq2Xm9Lp4Rt8Wz"


@pytest.mark.parametrize("path", _CASES["must_exclude"])
def test_a_credential_file_is_excluded(path):
    assert is_excluded_flight_path(path), f"{path!r} would be recorded"


@pytest.mark.parametrize("path", _CASES["must_exclude"])
def test_the_contents_of_a_credential_file_never_reach_the_log(path):
    """The point of the exclusion: siblings are blanked, not just the locator."""
    recorded = sanitize_flight_metadata({"path": path, "content": OPAQUE_SECRET})
    assert recorded["content"] == EXCLUDED_PATH


@pytest.mark.parametrize("path", _CASES["must_keep"])
def test_an_ordinary_file_is_not_excluded(path):
    """A false positive blanks every sibling field, destroying the record."""
    assert not is_excluded_flight_path(path), f"{path!r} was excluded; the record is lost"
