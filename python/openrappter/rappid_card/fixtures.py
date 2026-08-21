"""Load and execute the byte-identical PR9 conformance deck."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

from . import pr9_reference as R
from .simulator import verify_card_link
from .types import CardVectorResult

PROVENANCE_COMMIT = "392f850"


def _vector_root() -> Path:
    source = (
        Path(__file__).resolve().parents[3]
        / "tests"
        / "vectors"
        / "rapp-1-392f850"
        / "rappid-card"
    )
    if source.is_dir():
        return source
    packaged = Path(__file__).resolve().parent / "test_vectors"
    if packaged.is_dir():
        return packaged
    raise FileNotFoundError("vendored PR9 RAPPID card vectors are unavailable")


@lru_cache(maxsize=1)
def load_rappid_card_deck() -> Dict[str, Any]:
    return json.loads((_vector_root() / "deck.json").read_text(encoding="utf-8"))


RAPPID_CARD_FIXTURE_NAMES = tuple(
    load_rappid_card_deck()["mandatory_scenarios"]
)


@dataclass(frozen=True)
class RappidCardFixture:
    name: str
    vector: Dict[str, Any]

    @property
    def frame(self) -> Dict[str, Any]:
        return self.vector["frame"]

    @property
    def deep_link(self) -> str:
        return self.vector["link"]

    @property
    def expected(self) -> Dict[str, Any]:
        return self.vector["expected"]


def build_rappid_card_fixture(name: str) -> RappidCardFixture:
    vector = next(
        (
            entry
            for entry in load_rappid_card_deck()["vectors"]
            if entry["name"] == name
        ),
        None,
    )
    if vector is None:
        raise ValueError(f"unknown PR9 RAPPID card scenario: {name}")
    return RappidCardFixture(name, vector)


def _parts() -> Dict[str, bytes]:
    return {
        name: base64.b64decode(value)
        for name, value in load_rappid_card_deck()["parts_b64"].items()
    }


def _trust(vector: Dict[str, Any]) -> R.CardTrustStore:
    keys = {
        entry["kid"]: base64.b64decode(entry["spki_der_b64"])
        for entry in load_rappid_card_deck()["trust"]
    }
    return R.CardTrustStore(keys, vector["runtime_policy_authority"])


def state_for_vector(vector: Dict[str, Any], path: str) -> R.SQLiteCardState:
    state = R.SQLiteCardState(path)
    for nonce in vector["state_seed"]["nonces"]:
        state.seed_nonce(
            nonce["nonce"],
            nonce["connection_id"],
            nonce["state"],
            nonce["utc"],
        )
    for sequence in vector["state_seed"]["sequences"]:
        state.seed_sequence(
            sequence["namespace"],
            sequence["authority"],
            sequence["seq"],
            sequence["view_hash"],
        )
    return state


def simulate_rappid_card_fixture(
    name: str,
    state_path: str,
    hydrated_parts: List[str] | None = None,
) -> CardVectorResult:
    vector = build_rappid_card_fixture(name).vector
    state = state_for_vector(vector, state_path)
    selected = vector["hydrated_parts"] if hydrated_parts is None else hydrated_parts
    parts = _parts()
    return verify_card_link(
        vector["link"],
        vector["frame"],
        _trust(vector),
        vector["now_utc"],
        vector["runtime_policy"],
        vector["authority_view"],
        vector["revocation_view"],
        state,
        vector["connection_id"],
        vector["fetch_trace"],
        {part: parts[part] for part in selected},
        vector["continuity"],
    )


def list_rappid_card_fixtures() -> List[Dict[str, Any]]:
    return [
        {
            "name": vector["name"],
            "profile": vector["frame"]["payload"]["profile"],
            "kind": vector["frame"]["kind"],
            "physical": vector["physical"],
            "expected": vector["expected"],
        }
        for vector in load_rappid_card_deck()["vectors"]
    ]


def physical_vector_bytes() -> tuple[bytes, bytes]:
    root = _vector_root()
    return (
        (root / "physical.rappid-card.json").read_bytes(),
        (root / "physical-payload.txt").read_bytes(),
    )


__all__ = [
    "PROVENANCE_COMMIT",
    "RAPPID_CARD_FIXTURE_NAMES",
    "RappidCardFixture",
    "build_rappid_card_fixture",
    "list_rappid_card_fixtures",
    "load_rappid_card_deck",
    "physical_vector_bytes",
    "simulate_rappid_card_fixture",
    "state_for_vector",
]
