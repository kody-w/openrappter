"""Canonical bytes, content addresses, and the one PRNG both runtimes share.

Mirrors ``typescript/src/rappids/canonical.ts``. Two runtimes only agree about
a hash if they agree about the bytes, so the canonical form is pinned in
exactly one place per runtime: keys sorted, no whitespace, ASCII-escaped.
Numbers use JavaScript's JSON binary64 spelling in both implementations;
exact-file sidecars remain the compatibility path for older live profiles.

The PRNG is a SHA-256 counter stream rather than ``random.Random``. The
generator that seeded the first sonic dimension used the Mersenne Twister,
which TypeScript cannot reproduce -- and a "deterministic" provider that only
agrees with itself inside one runtime is not deterministic in a two-runtime
product. Everything downstream is integer arithmetic for the same reason: a
float comparison landing one ulp apart would silently select a different
candidate on the other runtime.
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any, Sequence, TypeVar

#: Domain separation in the shape RAPP/1 5 established and
#: ``typescript/src/identity/name.ts`` already uses (``rapp/1:rappid``). New
#: domains are added here rather than by concatenating raw values, so a seed
#: for one purpose can never collide with a seed for another.
AUTOCOMPLETE_DOMAIN = "quantum-rappid/1:autocomplete"
PROPOSAL_DOMAIN = "quantum-rappid/1:proposal"
RAPP_PARTICLE_DOMAIN = "rapp/1:particle"
RAPP_WAVE_DOMAIN = "rapp/1:wave"
RAPP_EGG_DOMAIN = "rapp/1:egg"

T = TypeVar("T")


def canonical_json(value: Any) -> str:
    """JSON with sorted keys, no spaces, ASCII escapes, and JS number form."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise ValueError(f"cannot canonicalise unsafe integer: {value}")
        return str(value)
    if isinstance(value, float):
        return _canonical_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("canonical JSON object keys must be strings")
        return (
            "{"
            + ",".join(
                f"{json.dumps(key, ensure_ascii=True)}:{canonical_json(value[key])}"
                for key in sorted(value)
            )
            + "}"
        )
    raise ValueError(f"cannot canonicalise non-JSON value: {type(value).__name__}")


def _canonical_number(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError(f"cannot canonicalise non-finite number: {value}")
    if value == 0:
        return "0"
    magnitude = abs(value)
    text = repr(value).lower()
    if value.is_integer():
        integer = int(value)
        if abs(integer) > 2**53 - 1:
            raise ValueError(f"cannot canonicalise unsafe integer: {value}")
        return str(integer)
    if 1e-6 <= magnitude < 1e21:
        fixed = format(Decimal(text), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    coefficient, exponent = text.split("e")
    coefficient = coefficient.rstrip("0").rstrip(".") if "." in coefficient else coefficient
    return f"{coefficient}e{int(exponent):+d}"


def sha256_hex(data: bytes | str) -> str:
    payload = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(payload).hexdigest()


def _validate_rapp_value(value: Any, depth: int = 1) -> None:
    if depth > 64:
        raise ValueError("RAPP/1 value exceeds depth 64")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise ValueError("RAPP/1 integer is not exactly representable")
        return
    if isinstance(value, float):
        raise ValueError("Quantum RAPPID frames use the RAPP/1 exact-integer profile")
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise ValueError("RAPP/1 string contains an unpaired surrogate")
        return
    if isinstance(value, list):
        for item in value:
            _validate_rapp_value(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("RAPP/1 object keys must be strings")
            if any(ord(character) > 0xFFFF for character in key):
                raise ValueError(
                    "RAPP/1 exact profile refuses supplementary-plane object keys"
                )
            _validate_rapp_value(key, depth + 1)
            _validate_rapp_value(item, depth + 1)
        return
    raise ValueError(f"RAPP/1 non-I-JSON value: {type(value).__name__}")


def rapp_canonical_json(value: Any) -> str:
    _validate_rapp_value(value)
    rendered = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    if len(rendered.encode("utf-8")) > 1024 * 1024:
        raise ValueError("RAPP/1 canonical form exceeds 1 MiB")
    return rendered


def rapp_h(space: str, value: Any) -> str:
    return sha256_hex(f"{space}\n{rapp_canonical_json(value)}")


def rapp_hb(space: str, payload: bytes) -> str:
    return hashlib.sha256(space.encode("ascii") + b"\n" + payload).hexdigest()


def canonical_digest(value: Any) -> str:
    """The content address of a value: sha256 over its canonical bytes."""
    return sha256_hex(canonical_json(value))


def domain_digest(domain: str, value: str) -> str:
    """``sha256("<domain>\\n<value>")`` -- RAPP/1 5 domain separation."""
    return sha256_hex(f"{domain}\n{value}")


def idiv(numerator: int, denominator: int) -> int:
    """Floor division for non-negative operands.

    Named rather than inlined because Python's ``//`` and JavaScript's ``/``
    agree about exactly this case and nothing else, and every use site here
    must be the case they agree about.
    """
    if denominator <= 0:
        raise ValueError("idiv requires a positive denominator")
    if numerator < 0:
        raise ValueError("idiv requires a non-negative numerator")
    return numerator // denominator


def round_half_up(value: float) -> int:
    """Half-up rounding, spelled out.

    ``round()`` rounds half to even and JavaScript's ``Math.round`` rounds half
    up, so neither built-in can be used where the two runtimes must agree.
    """
    return math.floor(value + 0.5)


def trait_milli(value: float) -> int:
    """A trait as an exact integer in thousandths -- the only form scoring sees."""
    if not math.isfinite(value):
        raise ValueError("trait must be a finite number")
    return round_half_up(value * 1000)


def micro_to_float(micro: int) -> float:
    """Millionths back to a float, for presentation only. Never for comparison."""
    return micro / 1_000_000


class DeterministicStream:
    """A deterministic byte stream, seeded by a hex digest.

    ``block_n = sha256("<seed>:<n>")``, consumed a byte at a time. Both runtimes
    produce the same bytes for the same seed, forever, offline.
    """

    def __init__(self, seed: str) -> None:
        if not seed:
            raise ValueError("DeterministicStream requires a seed")
        self._seed = seed
        self._counter = 0
        self._block = b""
        self._offset = 0

    def _next_byte(self) -> int:
        if self._offset >= len(self._block):
            self._block = hashlib.sha256(
                f"{self._seed}:{self._counter}".encode("utf-8")
            ).digest()
            self._counter += 1
            self._offset = 0
        byte = self._block[self._offset]
        self._offset += 1
        return byte

    def next_uint32(self) -> int:
        return (
            self._next_byte() * 0x1000000
            + self._next_byte() * 0x10000
            + self._next_byte() * 0x100
            + self._next_byte()
        )

    def next_below(self, bound: int) -> int:
        """A uniform integer in ``[0, bound)``. Rejection sampled, so unbiased."""
        if not isinstance(bound, int) or isinstance(bound, bool) or bound <= 0:
            raise ValueError("next_below requires a positive integer bound")
        limit = (0x100000000 // bound) * bound
        while True:
            value = self.next_uint32()
            if value < limit:
                return value % bound

    def pick(self, items: Sequence[T]) -> T:
        if not items:
            raise ValueError("pick requires a non-empty sequence")
        return items[self.next_below(len(items))]

    def weighted_index(self, weights: Sequence[int]) -> int:
        """Index chosen in proportion to integer weights."""
        total = 0
        for weight in weights:
            if not isinstance(weight, int) or isinstance(weight, bool) or weight < 0:
                raise ValueError("weights must be non-negative integers")
            total += weight
        if total <= 0:
            raise ValueError("weights must not sum to zero")
        roll = self.next_below(total)
        for index, weight in enumerate(weights):
            if roll < weight:
                return index
            roll -= weight
        raise AssertionError("weighted selection fell through")
