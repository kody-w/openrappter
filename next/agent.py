"""Target-owned Brainstem adapter contract. Not an alternative brainstem runtime."""
from typing import Protocol, TypedDict


class RootScope(TypedDict):
    root: str
    scope: str
    canonical_head: str | None
    capability_sha256: str


class Agent(Protocol):
    """A verified external spine must isolate each root before implementing this."""

    def public_response(self, scope: RootScope, thought: str, canonical_context: str) -> str:
        """Return public response JSON only; never hidden reasoning or side effects."""
        ...
