"""Both runtimes' flight recorders must redact the same field names.

The question this file asks is deliberately narrow: given a key, does its
*name* say the value must never be recorded? Its sibling
`test_value_redaction_parity.py` asks whether a value *looks* like a secret.
Either check alone leaves a hole, and this was the open one -- an opaque random
string, which is what most API keys and session keys actually are, matches no
value pattern at all and can only be caught by its key.

Measured before this test existed, the flight recorder wrote 19 secret-bearing
field names to disk in the clear, in both runtimes, including `secrets`,
`tokens`, `auth`, `bearer`, `jwt`, `sshKey` and `sessionKey`. The cause was a
fourth private copy of rules that `security/secret_keys.py` already exists to
be the single answer to -- a module whose own docstring records that this
project keeps growing separate copies of this list and that each one misses
what the others catch.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openrappter.flight_recorder import sanitize_flight_metadata
from openrappter.security.secret_keys import is_secret_key

CORPUS = Path(__file__).resolve().parents[2] / "contracts" / "key-redaction-corpus.json"
_CASES = json.loads(CORPUS.read_text())

#: Matches no SECRET_VALUE_PATTERN, so only the key's name can save it.
OPAQUE = "a7Fq2Xm9Lp4Rt8Wz"


def _recorded(key: str) -> object:
    return sanitize_flight_metadata({key: OPAQUE}).get(key)


@pytest.mark.parametrize("key", _CASES["must_redact"])
def test_a_secret_field_name_never_reaches_the_flight_log(key):
    assert _recorded(key) != OPAQUE, f"{key!r} was written to the flight log in the clear"


@pytest.mark.parametrize("key", _CASES["must_keep"])
def test_an_ordinary_field_name_stays_readable(key):
    """A ledger that blanks ordinary fields keeps the record and loses the ability
    to read it, so over-redaction is a real failure and not a safe default."""
    assert _recorded(key) == OPAQUE, f"{key!r} was redacted; the record becomes unreadable"


def test_the_flight_recorder_redacts_everything_the_canonical_module_calls_secret():
    """The structural guard, and the reason this class of bug is now closed.

    Any private list will drift from the shared one eventually; the fix that
    lasts is making drift a test failure rather than trusting the next person to
    notice. This asserts containment rather than equality, because the flight
    recorder legitimately redacts more (prototype-pollution keys, and whatever
    the operator names in `privacy.redactedKeys`).
    """
    missed = [
        key
        for key in _CASES["must_redact"] + _CASES["must_keep"]
        if is_secret_key(key) and _recorded(key) == OPAQUE
    ]
    assert not missed, f"canonical module calls these secret, flight recorder did not: {missed}"
