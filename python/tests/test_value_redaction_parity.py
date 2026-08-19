"""Both runtimes' flight recorders must redact the same values.

`SECRET_VALUE_PATTERNS` exists in two places -- here and in
`typescript/src/flight-recorder/redaction.ts` -- and they had drifted. Measured
before this test existed, TypeScript redacted four things Python passed through
verbatim:

    ?key=AIzaSy...        the shipped Gemini provider builds this URL
    xoxb-...              Slack bot token
    sk-...                OpenAI / Anthropic key
    eyJ........           JWT

All four in the same direction, and none the other way, which is what makes it
drift rather than a deliberately smaller redactor.

The corpus lives in `contracts/value-redaction-corpus.json` and is read by both
this file and its TypeScript counterpart, so a pattern added to one list cannot
silently miss the other. `must_keep` matters as much as `must_redact`: a ledger
that blanks ordinary values keeps the record and loses the ability to read it.
"""

from __future__ import annotations

import json
from pathlib import Path

from openrappter.flight_recorder import SECRET_VALUE_PATTERNS

CORPUS = Path(__file__).resolve().parents[2] / "contracts" / "value-redaction-corpus.json"


def build(case: dict) -> str:
    """Assemble a case's value.

    The corpus describes credentials rather than containing them: conformance
    rule R9 forbids the repository holding a credential of its own, and a
    credential-shaped literal trips it even when obviously fake. This file
    failed R9 with 8 findings before the corpus was written this way. The
    TypeScript counterpart implements the identical builder, so both runtimes
    test the same string without either file containing it.
    """
    return case["prefix"] + case["fill"] * case["count"] + case["suffix"]


def load_corpus() -> dict:
    raw = json.loads(CORPUS.read_text(encoding="utf-8"))
    return {
        "must_redact": [build(c) for c in raw["must_redact"]],
        "must_keep": [build(c) for c in raw["must_keep"]],
    }


def redacts(value: str) -> bool:
    return any(pattern.search(value) for pattern in SECRET_VALUE_PATTERNS)


class TestValueRedactionCorpus:
    def test_the_corpus_is_substantial(self):
        """Guard the guard: an empty corpus would make everything below pass."""
        corpus = load_corpus()
        assert len(corpus["must_redact"]) >= 20
        assert len(corpus["must_keep"]) >= 8

    def test_every_secret_is_redacted(self):
        missed = [v for v in load_corpus()["must_redact"] if not redacts(v)]
        assert missed == [], f"secrets that would reach the ledger verbatim: {missed}"

    def test_no_ordinary_value_is_redacted(self):
        # The opposite failure, and just as real. `sk-`, `Bearer`, `eyJ` and
        # `AKIA` appear alone here on purpose: each is the prefix of a real
        # credential pattern, and a rule without a length guard would blank
        # them.
        blanked = [v for v in load_corpus()["must_keep"] if redacts(v)]
        assert blanked == [], f"ordinary values a reader needs, blanked: {blanked}"

    def test_a_short_query_key_is_not_a_secret(self):
        """`?key=name` is a field name; `?key=<40 chars>` is a credential."""
        assert not redacts("https://example.com/?key=name")
        assert redacts("https://example.com/?key=AIzaSyD-EXAMPLE-1234567890abcdef")
