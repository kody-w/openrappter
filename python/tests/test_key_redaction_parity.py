"""Both runtimes' flight recorders must redact the same field names.

The question here is deliberately narrow: given a key, does its *name* say the
value must never be recorded? Its sibling `test_value_redaction_parity.py` asks
whether a value *looks* like a secret. Either check alone leaves a hole, and
this was the open one -- an opaque random string, which is what most API keys
and session keys actually are, matches no value pattern at all and can only be
caught by its key.

Measured before this test existed, both runtimes wrote 19 secret-bearing field
names to disk in the clear. The rules matched `token`, `secret` and
`authorization` as exact words while matching `password`, `credential` and
`cookie` as prefixes, so `secrets`, `tokens`, `clientSecrets` and `apiTokens`
were recorded verbatim while their singulars were redacted.

`must_keep` matters as much as `must_redact`. The flight recorder is
deliberately conservative and this test is the record of that: `key`, `auth`,
`salt`, `nonce` and `bearer` stay readable on purpose, because a ledger that
redacts too much keeps the record and loses the ability to read it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openrappter.flight_recorder import sanitize_flight_metadata

CORPUS = Path(__file__).resolve().parents[2] / "contracts" / "key-redaction-corpus.json"
_CASES = json.loads(CORPUS.read_text())

#: Matches no SECRET_VALUE_PATTERN, so only the key's name can save it.
OPAQUE = "a7Fq2Xm9Lp4Rt8Wz"


def _recorded(key: str, value: object = OPAQUE) -> object:
    return sanitize_flight_metadata({key: value}).get(key)


@pytest.mark.parametrize("key", _CASES["must_redact"])
def test_a_secret_field_name_never_reaches_the_flight_log(key):
    assert _recorded(key) != OPAQUE, f"{key!r} was written to the flight log in the clear"


@pytest.mark.parametrize("key", _CASES["must_keep"])
def test_an_ordinary_field_name_stays_readable(key):
    """Over-redaction is a real failure, not a safe default.

    The damage from adding a word here is invisible: nothing fails, the ledger
    just quietly stops saying anything.
    """
    assert _recorded(key) == OPAQUE, f"{key!r} was redacted; the record becomes unreadable"


@pytest.mark.parametrize("key", _CASES["counts"])
class TestTokenIsAlsoAUnit:
    """`token` is the one secret word that doubles as a unit of measurement."""

    def test_a_numeric_count_is_kept(self, key):
        """Usage accounting records these on every provider call. Blanking them
        protects nothing -- a bare number cannot be a credential -- and destroys
        the numbers the Bar reports."""
        assert _recorded(key, 120) == 120

    def test_the_same_name_carrying_a_string_is_still_redacted(self, key):
        """The value has to decide, because the name cannot: `apiTokens` and
        `inputTokens` are the same shape and only one holds credentials."""
        assert _recorded(key, OPAQUE) != OPAQUE
