"""`generate_snippet` and its TypeScript twin do not agree, and that is recorded.

#68 measured the two implementations disagreeing on most inputs and deliberately
did **not** pick a winner: TypeScript trims to word boundaries and reads better,
Python backfills so the snippet uses the `max_length` the caller asked for, and
choosing changes output for every existing caller. That is a product decision
about what a memory snippet should look like.

What the issue asked for instead was that it be *written down*, because
`SPEC.md` says nothing about it and "the next person to diff these will file
this issue again".

So `contracts/snippet-divergence.json` records every case with **both** answers,
and this test asserts the Python column. Its TypeScript counterpart asserts the
other one. Neither endorses its side; together they mean:

  * the divergence cannot widen without a test failing,
  * whoever resolves it can see exactly what changes, and
  * nobody has to re-derive the table by hand.
"""

from __future__ import annotations

import json
from pathlib import Path

from openrappter.memory.chunker import generate_snippet

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "snippet-divergence.json"


def load() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


class TestSnippetDivergence:
    def test_the_record_is_substantial(self):
        """Guard the guard: an empty table would make everything below pass."""
        data = load()
        assert len(data["cases"]) >= 10
        assert data["max_length"] > 0

    def test_it_still_records_a_real_disagreement(self):
        """If these ever agree, the record is stale and should be deleted.

        Asserted so the file cannot outlive the problem it documents: a
        contract describing a divergence that no longer exists is worse than
        no contract, because it teaches the next reader something false.
        """
        data = load()
        disagreements = [c for c in data["cases"] if not c["agree"]]
        assert disagreements, (
            "the two runtimes now agree — resolve #68 and delete "
            "contracts/snippet-divergence.json"
        )

    def test_python_still_answers_what_the_record_says(self):
        data = load()
        max_length = data["max_length"]
        drifted = []
        for case in data["cases"]:
            got = generate_snippet(case["content"], case["query"], max_length)
            if got != case["python"]:
                drifted.append((case["label"], case["python"], got))

        assert drifted == [], (
            "Python's snippet output changed. If that was deliberate, update "
            f"contracts/snippet-divergence.json: {drifted}"
        )
